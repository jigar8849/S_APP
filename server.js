import express from 'express';
import { createProxyMiddleware } from 'http-proxy-middleware';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import dotenv from 'dotenv';
import path from 'path';
import mongoose from 'mongoose';
import { fileURLToPath } from 'url';
import '@shopify/shopify-api/adapters/node';
import { shopifyApi, ApiVersion, DeliveryMethod } from '@shopify/shopify-api';
import Shop from './models/Shop.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

// Connect to MongoDB
mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shopify_order_app', {
  serverSelectionTimeoutMS: 5000
}).then(() => console.log('✅ Connected to MongoDB'))
  .catch(err => {
    console.error('❌ MongoDB connection error:', err.message);
    if (err.message.includes('Authentication failed')) {
      console.error('👉 TIP: Check your .env file and ensure the username and password match your MongoDB Atlas Database User.');
    }
  });

const app = express();
app.set('trust proxy', 1); // Essential for fixed domains on AWS to handle HTTPS correctly
app.use(cors());
app.use(cookieParser());
app.use(express.json()); // Moved to top to resolve 415 Media Type errors during registration

// Request logger middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

const clients = {};

function notifyClients(shop, count) {
  if (clients[shop]) {
    clients[shop].forEach(res => res.write(`data: ${JSON.stringify({ count })}\n\n`));
  }
}

const hostName = process.env.HOST ? process.env.HOST.replace(/https:\/\//, '') : 'localhost:5000';
console.log(`[Config] Using Hostname: ${hostName}`);

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY || 'fake_api_key',
  apiSecretKey: process.env.SHOPIFY_API_SECRET || 'fake_api_secret',
  scopes: process.env.SCOPES ? process.env.SCOPES.split(',') : ['write_products', 'read_orders'],
  hostName: hostName,
  hostScheme: 'https',
  apiVersion: '2026-04', // Updated to the latest April 2026 version
  isEmbeddedApp: true,
});

shopify.webhooks.addHandlers({
  ORDERS_CREATE: {
    deliveryMethod: DeliveryMethod.Http,
    callbackUrl: '/api/webhooks',
    callback: async (topic, shop, body, webhookId) => {
      const order = JSON.parse(body);
      console.log(`[Webhook] ${topic} received for ${shop}. Order ID: ${order.id}`);
      try {
        const store = await Shop.findOneAndUpdate(
          { shop },
          { $inc: { orderCount: 1 } },
          { returnDocument: 'after' }
        );
        if (store) {
          notifyClients(shop, store.orderCount);
          console.log(`[Webhook] Successfully incremented order count for ${shop} to ${store.orderCount}`);
        } else {
          console.error(`[Webhook] Could not find store ${shop} to update count`);
        }
      } catch (err) {
        console.error(`[Webhook] Error updating order count for ${shop}:`, err);
      }
    },
  },
});

app.post('/api/webhooks', express.text({ type: '*/*' }), async (req, res) => {
  try {
    await shopify.webhooks.process({
      rawBody: req.body,
      rawRequest: req,
      rawResponse: res,
    });
    console.log('[Webhook] processed successfully');
  } catch (error) {
    console.error(`[Webhook] Failed to process webhook: ${error.message}`);
    if (!res.headersSent) {
      res.status(500).json({ error: 'Webhook processing failed', message: error.message });
    }
  }
});

// Removed app.use(express.json()) from here as it was moved to the top.

// 1. App Installation (Authentication) - Begin OAuth
app.get('/api/auth', async (req, res) => {
  const shop = shopify.utils.sanitizeShop(req.query.shop, true);
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  // Detect if we are in an iFrame (Shopify sends the 'host' parameter for embedded requests)
  const isEmbedded = !!req.query.host;

  // We MUST break out of the iFrame to set the OAuth cookie successfully.
  // Browsers block cookies if they are set inside an iFrame.
  if (isEmbedded && !req.query.is_redirected) {
    console.log(`[Auth] iFrame detected for ${shop}. Breaking out to top window...`);
    const authUrl = `${process.env.HOST}/api/auth?shop=${shop}&is_redirected=true`;
    
    // This small HTML snippet forces the parent Shopify Admin window to redirect
    return res.send(`
      <!DOCTYPE html>
      <html>
        <head>
          <script type="text/javascript">
            window.top.location.href = "${authUrl}";
          </script>
        </head>
        <body>
          <p>Redirecting to login...</p>
        </body>
      </html>
    `);
  }

  try {
    console.log(`[Auth] Starting OAuth process for: ${shop}`);
    // Begins real authentication with Shopify Partners:
    await shopify.auth.begin({
      shop,
      callbackPath: '/api/auth/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (error) {
    console.error(`[Auth] CRITICAL ERROR for ${shop}:`, error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'Failed to begin OAuth', 
        message: error.message,
        stack: process.env.NODE_ENV === 'development' ? error.stack : undefined 
      });
    }
  }
});

// 2. Auth Callback
app.get('/api/auth/callback', async (req, res) => {
  try {
    console.log(`[AuthCallback] Received callback for ${req.query.shop}. Validating...`);
    const callbackResponse = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    
    // Extract the session from the callback
    const session = callbackResponse.session;
    console.log(`[AuthCallback] Success! Authenticated shop: ${session.shop}`);
    
    // Store in our database
    await Shop.findOneAndUpdate(
      { shop: session.shop },
      { shop: session.shop, session, isInstalled: true },
      { upsert: true, returnDocument: 'after' }
    );

    // Register webhooks after authenticating
    try {
      const response = await shopify.webhooks.register({ session });
      console.log('[AuthCallback] Webhooks registered:', response);
    } catch (e) {
      console.error('[AuthCallback] Failed to register webhooks:', e.message);
    }

    // Send the user to the embedded app frontend
    const host = req.query.host;
    const redirectUrl = `/?shop=${session.shop}&host=${host}`;
    
    console.log(`[AuthCallback] Redirecting user to app dashboard: ${redirectUrl}`);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('[AuthCallback] CRITICAL OAUTH ERROR:', error);
    if (!res.headersSent) {
      res.status(500).json({ 
        error: 'OAuth callback failed', 
        message: error.message,
        details: 'Check if your browser is blocking cookies or if the redirect URIs in Shopify Partner Dashboard are correct.' 
      });
    }
  }
});

// 3. API Endpoint to Get Order Count
app.get('/api/orders/count', async (req, res) => {
  const shop = shopify.utils.sanitizeShop(req.query.shop, true);
  
  try {
    if (!shop) {
       console.log('[OrderCount] API called without a valid shop parameter');
       return res.status(400).json({ error: 'Missing shop parameter' });
    }

    let store = await Shop.findOne({ shop });
    
    if (!store) {
      console.log(`[OrderCount] Store document NOT FOUND in DB for: ${shop}`);
      return res.status(401).json({ error: 'Auth Required', message: 'Store not found. Please re-install.' });
    }

    if (!store.session) {
      console.log(`[OrderCount] Session MISSING for store: ${shop}`);
      return res.status(401).json({ error: 'Session Expired', message: 'Please login via Shopify Admin.' });
    }

    const session = store.session;
    console.log(`[OrderCount] Fetching count for: ${shop} using stored session`);

    // Use Shopify REST API to get the TOTAL order count
    const client = new shopify.clients.Rest({ session });
    const countResponse = await client.get({
      path: 'orders/count',
    });

    const totalCount = countResponse.body.count;
    console.log(`[OrderCount] SUCCESS: Fetched real count from Shopify for ${shop}: ${totalCount}`);

    // Update our DB with the latest count from Shopify
    store.orderCount = totalCount;
    await store.save();
    
    res.json({ count: totalCount });
  } catch (error) {
    console.error(`[OrderCount] ERROR for ${shop || 'unknown shop'}:`, error.message);
    
    // Check for specific Shopify API errors
    if (error.message.includes('401') || error.message.includes('Unauthorized')) {
      console.log(`[OrderCount] Shopify API returned 401 (Unauthorized) for ${shop}. Clearing session...`);
      await Shop.findOneAndUpdate({ shop }, { session: null, isInstalled: false });
      return res.status(401).json({ 
        error: 'Unauthorized', 
        message: 'Your session has expired. Please refresh the page to re-authenticate.' 
      });
    }

    if (error.message.includes('403') || error.message.includes('Forbidden')) {
      console.log(`[OrderCount] Shopify API returned 403 (Forbidden) for ${shop}. Missing scopes?`);
      return res.status(403).json({ 
        error: 'Permission Denied', 
        message: 'App lacks required permissions. Please re-install.' 
      });
    }

    res.status(500).json({ 
      error: 'Backend Error', 
      message: error.message,
      tip: 'Check server logs for details.'
    });
  }
});

// 4. SSE stream endpoint for real-time order count updates
app.get('/api/orders/stream', (req, res) => {
  const shop = req.query.shop;
  if (!shop) return res.status(400).end();

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Send initial ping to establish connection nicely
  res.write(': ping\n\n');
  
  if (!clients[shop]) {
    clients[shop] = [];
  }
  
  clients[shop].push(res);
  
  req.on('close', () => {
    clients[shop] = clients[shop].filter(client => client !== res);
  });
});

// In development, any request that doesn't match an API route is proxied to Vite
if (process.env.NODE_ENV !== 'production') {
  app.use(
    '/',
    createProxyMiddleware({
      target: 'http://localhost:5173',
      changeOrigin: true,
      ws: true,
      pathFilter: (path) => !path.startsWith('/api') // Don't proxy API or auth routes
    })
  );
}

// Serve frontend in production
const isProd = process.env.NODE_ENV === 'production';
if (isProd) {
  const buildPath = path.join(process.cwd(), 'frontend', 'dist');
  app.use(express.static(buildPath));
  
  // Any request that doesn't match an API route gets the React App
  app.get('/*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

export default app;
