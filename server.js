import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import http from 'http';
import { Server } from 'socket.io';
import webpush from 'web-push';

const app = express();
const server = http.createServer(app);

// --------------------------------------------------
// CORS CONFIGURATION
// --------------------------------------------------

const configuredOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(s => s.trim().replace(/\/$/, ''))
  .filter(Boolean);

// All EMMC frontend origins
const allowed = [...new Set([
  ...configuredOrigins,

  // Current Police Vercel
  'https://emmc-maps-gps-police-alert.vercel.app',

  // Older Police Vercel
  'https://emms-maps-gps-module.vercel.app',

  // Current Ambulance Vercel
  'https://emmc-ambulance-dashboard.vercel.app',

  // Local development
  'http://localhost:5173',
  'http://localhost:5174'
])];

console.log('Allowed frontend origins:', allowed);

// Express CORS
app.use(cors({
  origin: (origin, callback) => {

    // Allow requests without Origin header
    // such as server-to-server requests
    if (!origin) {
      return callback(null, true);
    }

    if (allowed.includes('*')) {
      return callback(null, true);
    }

    if (allowed.includes(origin)) {
      return callback(null, true);
    }

    console.warn(
      'CORS blocked origin:',
      origin
    );

    return callback(
      new Error('Not allowed by CORS')
    );
  },

  methods: [
    'GET',
    'POST',
    'PUT',
    'DELETE',
    'OPTIONS'
  ],

  allowedHeaders: [
    'Content-Type',
    'Authorization'
  ]
}));

app.use(express.json({ limit: '100kb' }));

// --------------------------------------------------
// SOCKET.IO
// --------------------------------------------------

const io = new Server(server, {
  cors: {
    origin: (origin, callback) => {

      if (!origin) {
        return callback(null, true);
      }

      if (allowed.includes('*')) {
        return callback(null, true);
      }

      if (allowed.includes(origin)) {
        return callback(null, true);
      }

      console.warn(
        'Socket.IO CORS blocked origin:',
        origin
      );

      return callback(
        new Error('Not allowed by Socket.IO CORS')
      );
    },

    methods: [
      'GET',
      'POST'
    ]
  }
});

const PORT = Number(
  process.env.PORT || 3001
);

// --------------------------------------------------
// DATA STORAGE
// --------------------------------------------------

const policeLocations = new Map();
const ambulanceLocations = new Map();
const subscriptions = new Map();
const lastPush = new Map();
const activeAlerts = new Set();

const RADIUS_KM = 1;

// --------------------------------------------------
// EMMC DEFAULT AMBULANCE INFORMATION
// --------------------------------------------------

const DEFAULT_AMBULANCE_ID =
  'AMB-1042';

const DEFAULT_DESTINATION =
  'Raj Hospital and Research Center, Ranchi';

const DEFAULT_EMERGENCY_CATEGORY =
  'Critical / High Priority';

// --------------------------------------------------
// VAPID / PUSH CONFIGURATION
// --------------------------------------------------

if (
  process.env.VAPID_PUBLIC_KEY &&
  process.env.VAPID_PRIVATE_KEY &&
  process.env.VAPID_SUBJECT
) {

  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT,
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );

} else {

  console.warn(
    'VAPID keys are not configured. Push notifications are disabled until server/.env is configured.'
  );
}

// --------------------------------------------------
// DISTANCE CALCULATION
// --------------------------------------------------

function distanceKm(a, b) {

  const R = 6371;

  const rad =
    Math.PI / 180;

  const dLat =
    (b.latitude - a.latitude) * rad;

  const dLng =
    (b.longitude - a.longitude) * rad;

  const x =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(a.latitude * rad) *
      Math.cos(b.latitude * rad) *
      Math.sin(dLng / 2) ** 2;

  const safeX =
    Math.min(
      1,
      Math.max(0, x)
    );

  return (
    R *
    2 *
    Math.atan2(
      Math.sqrt(safeX),
      Math.sqrt(1 - safeX)
    )
  );
}

// --------------------------------------------------
// VALID GPS
// --------------------------------------------------

function valid(lat, lng) {

  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= -90 &&
    lat <= 90 &&
    lng >= -180 &&
    lng <= 180
  );
}

// --------------------------------------------------
// RANGE CHECK
// --------------------------------------------------

function inRange(a, b) {

  return (
    valid(
      a.latitude,
      a.longitude
    ) &&
    valid(
      b.latitude,
      b.longitude
    ) &&
    distanceKm(a, b) <= RADIUS_KM
  );
}

// --------------------------------------------------
// PUSH TO POLICE
// --------------------------------------------------

async function pushToPolice(
  policeId,
  payload
) {

  const sub =
    subscriptions.get(policeId);

  if (
    !sub ||
    !process.env.VAPID_PUBLIC_KEY ||
    !process.env.VAPID_PRIVATE_KEY ||
    !process.env.VAPID_SUBJECT
  ) {
    return false;
  }

  try {

    await webpush.sendNotification(
      sub,
      JSON.stringify(payload)
    );

    return true;

  } catch (err) {

    if (
      err.statusCode === 404 ||
      err.statusCode === 410
    ) {

      subscriptions.delete(
        policeId
      );
    }

    console.error(
      'Push delivery error:',
      err.message
    );

    return false;
  }
}

// ==================================================
// HEALTH
// ==================================================

app.get(
  '/api/health',
  (_req, res) =>
    res.json({

      ok: true,

      service:
        'EMMC Push Backend',

      pushConfigured:
        Boolean(
          process.env.VAPID_PUBLIC_KEY &&
          process.env.VAPID_PRIVATE_KEY &&
          process.env.VAPID_SUBJECT
        )
    })
);

// ==================================================
// TRAFFIC POLICE STATUS
// ==================================================

app.get(
  '/api/traffic-police',
  (_req, res) => {

    const police =
      policeLocations.get('TP001') ||
      null;

    res.json({

      ok: true,

      policeOnline:
        policeLocations.size,

      ambulancesOnline:
        ambulanceLocations.size,

      police:
        police
          ? {
              ...police,
              isLive: true,
              lastUpdated:
                police.updatedAt
            }
          : null
    });
  }
);

// ==================================================
// AMBULANCE STATUS
// ==================================================

app.get(
  '/api/ambulances',
  (_req, res) => {

    res.json({

      ok: true,

      ambulancesOnline:
        ambulanceLocations.size,

      ambulances: [
        ...ambulanceLocations.values()
      ].map(amb => ({

        ...amb,

        isLive: true,

        lastUpdated:
          amb.updatedAt
      }))
    });
  }
);

// ==================================================
// PUSH PUBLIC KEY
// ==================================================

app.get(
  '/api/push/public-key',
  (_req, res) =>
    res.json({

      publicKey:
        process.env.VAPID_PUBLIC_KEY || ''
    })
);

// ==================================================
// PUSH SUBSCRIPTION
// ==================================================

app.post(
  '/api/push/subscribe',
  (req, res) => {

    const {
      policeId,
      subscription
    } = req.body || {};

    if (
      !policeId ||
      !subscription?.endpoint
    ) {

      return res.status(400).json({

        message:
          'policeId and subscription are required'
      });
    }

    subscriptions.set(
      policeId,
      subscription
    );

    res.json({

      ok: true,

      message:
        'Mobile push subscription saved'
    });
  }
);

// ==================================================
// TRAFFIC POLICE REAL GPS
// ==================================================

app.post(
  '/api/traffic-police/location',
  async (req, res) => {

    const {
      policeId,
      latitude,
      longitude
    } = req.body || {};

    if (
      !policeId ||
      !valid(
        Number(latitude),
        Number(longitude)
      )
    ) {

      return res.status(400).json({

        message:
          'Invalid police location'
      });
    }

    const p = {

      policeId,

      latitude:
        Number(latitude),

      longitude:
        Number(longitude),

      updatedAt:
        Date.now()
    };

    policeLocations.set(
      policeId,
      p
    );

    // Real police GPS
    io.emit(
      'policeLocation',
      p
    );

    io.emit(
      'trafficPoliceLocation',
      p
    );

    await checkProximityForPolice(
      p
    );

    res.json({

      ok: true,

      police: p
    });
  }
);

// ==================================================
// CHECK AMBULANCE WITHIN 1 KM
// ==================================================

async function checkProximityForPolice(
  police
) {

  for (
    const amb of
      ambulanceLocations.values()
  ) {

    if (
      !valid(
        Number(amb.latitude),
        Number(amb.longitude)
      )
    ) {
      continue;
    }

    const d =
      distanceKm(
        police,
        amb
      );

    const key =
      `${police.policeId}:${amb.ambulanceId}`;

    // ----------------------------------------------
    // WITHIN 1 KM
    // ----------------------------------------------

    if (d <= RADIUS_KM) {

      const now =
        Date.now();

      // Send immediately when entering
      // and maximum once per minute.
      if (
        !lastPush.has(key) ||
        now -
          lastPush.get(key) >
          60000
      ) {

        lastPush.set(
          key,
          now
        );

        activeAlerts.add(
          key
        );

        const distanceMeters =
          Math.round(
            d * 1000
          );

        const emergencyCategory =
          amb.emergencyCategory ||
          DEFAULT_EMERGENCY_CATEGORY;

        const destination =
          amb.destination ||
          DEFAULT_DESTINATION;

        const action =
          'Please clear traffic / remove the jam and give the ambulance a clear route.';

        const payload = {

          policeId:
            police.policeId,

          ambulanceId:
            amb.ambulanceId,

          title:
            '🚨 TRAFFIC ALERT — AMBULANCE WITHIN 1 KM',

          body:
            `${amb.ambulanceId} is ${distanceMeters} m away. ${emergencyCategory}. ${action}`,

          message:
            `🚑 Ambulance ${amb.ambulanceId} is within the 1 km Traffic Police radius. Please clear traffic / jam immediately and assist the ambulance.`,

          tag:
            `emmc-${amb.ambulanceId}`,

          data: {

            ambulanceId:
              amb.ambulanceId,

            policeId:
              police.policeId,

            distanceMeters,

            latitude:
              amb.latitude,

            longitude:
              amb.longitude,

            destination,

            emergencyCategory,

            action
          }
        };

        // ------------------------------------------
        // IN-APP POLICE ALERT
        // ------------------------------------------

        io.to(
          `police:${police.policeId}`
        ).emit(
          'policeAlert',
          payload
        );

        // ------------------------------------------
        // BACKWARD COMPATIBILITY
        // ------------------------------------------

        io.to(
          `police:${police.policeId}`
        ).emit(
          'trafficPoliceAlert',
          payload
        );

        // ------------------------------------------
        // REAL MOBILE PUSH
        // ------------------------------------------

        await pushToPolice(
          police.policeId,
          payload
        );
      }

    } else {

      // ------------------------------------------
      // OUTSIDE 1 KM
      // ------------------------------------------

      if (
        activeAlerts.has(key)
      ) {

        io.to(
          `police:${police.policeId}`
        ).emit(
          'trafficPoliceAlertCleared',
          {

            policeId:
              police.policeId,

            ambulanceId:
              amb.ambulanceId,

            message:
              'Ambulance is now outside the 1 km Traffic Police radius.'
          }
        );
      }

      activeAlerts.delete(
        key
      );

      lastPush.delete(
        key
      );
    }
  }
}

// ==================================================
// AMBULANCE REAL GPS
// ==================================================

app.post(
  '/api/ambulance/location',
  async (req, res) => {

    const {

      ambulanceId =
        DEFAULT_AMBULANCE_ID,

      latitude,

      longitude,

      destination =
        DEFAULT_DESTINATION,

      emergencyCategory =
        DEFAULT_EMERGENCY_CATEGORY,

      heading = null

    } = req.body || {};

    // ----------------------------------------------
    // VALIDATE GPS
    // ----------------------------------------------

    if (
      !valid(
        Number(latitude),
        Number(longitude)
      )
    ) {

      return res.status(400).json({

        message:
          'Invalid ambulance location'
      });
    }

    // ----------------------------------------------
    // CLEAN AMBULANCE ID
    // ----------------------------------------------

    const cleanAmbulanceId =
      String(
        ambulanceId ||
          DEFAULT_AMBULANCE_ID
      )
        .trim()
        .toUpperCase();

    // ----------------------------------------------
    // CLEAN DESTINATION
    // ----------------------------------------------

    const cleanDestination =
      String(
        destination ||
          DEFAULT_DESTINATION
      ).trim();

    // ----------------------------------------------
    // CLEAN EMERGENCY CATEGORY
    // ----------------------------------------------

    const cleanEmergencyCategory =
      String(
        emergencyCategory ||
          DEFAULT_EMERGENCY_CATEGORY
      ).trim();

    // ----------------------------------------------
    // AMBULANCE DATA
    // ----------------------------------------------

    const amb = {

      ambulanceId:
        cleanAmbulanceId,

      latitude:
        Number(latitude),

      longitude:
        Number(longitude),

      destination:
        cleanDestination,

      emergencyCategory:
        cleanEmergencyCategory,

      heading,

      updatedAt:
        Date.now()
    };

    // ----------------------------------------------
    // SAVE REAL AMBULANCE GPS
    // ----------------------------------------------

    ambulanceLocations.set(
      cleanAmbulanceId,
      amb
    );

    // ----------------------------------------------
    // SEND REAL GPS TO CONNECTED CLIENTS
    // ----------------------------------------------

    io.emit(
      'ambulanceLocation',
      amb
    );

    // ----------------------------------------------
    // CHECK ALL CONNECTED POLICE
    // ----------------------------------------------

    for (
      const police of
        policeLocations.values()
    ) {

      await checkProximityForPolice(
        police
      );
    }

    res.json({

      ok: true,

      ambulance:
        amb
    });
  }
);

// ==================================================
// SOCKET.IO EVENTS
// ==================================================

io.on(
  'connection',
  socket => {

    console.log(
      'Socket connected:',
      socket.id
    );

    socket.on(
      'registerPolice',
      ({ policeId } = {}) => {

        if (policeId) {

          socket.join(
            `police:${policeId}`
          );

          console.log(
            `Police registered: ${policeId}`
          );
        }
      }
    );

    socket.on(
      'disconnect',
      reason => {

        console.log(
          'Socket disconnected:',
          socket.id,
          reason
        );
      }
    );
  }
);

// ==================================================
// START SERVER
// ==================================================

server.listen(
  PORT,
  () => {

    console.log(
      `EMMC backend listening on :${PORT}`
    );

    console.log(
      'Ambulance Vercel allowed:',
      'https://emmc-ambulance-dashboard.vercel.app'
    );

    console.log(
      'Police Vercel allowed:',
      'https://emmc-maps-gps-police-alert.vercel.app'
    );
  }
);
