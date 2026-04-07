import express from 'express';
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
}).then(() => console.log('Connected to MongoDB'))
  .catch(err => console.error('MongoDB connection error:', err));

const app = express();
app.use(cors());
app.use(cookieParser());
const clients = {};

function notifyClients(shop, count) {
  if (clients[shop]) {
    clients[shop].forEach(res => res.write(`data: ${JSON.stringify({ count })}\n\n`));
  }
}

const shopify = shopifyApi({
  apiKey: process.env.SHOPIFY_API_KEY || 'fake_api_key',
  apiSecretKey: process.env.SHOPIFY_API_SECRET || 'fake_api_secret',
  scopes: ['read_orders'],
  hostName: process.env.HOST ? process.env.HOST.replace(/https:\/\//, '') : 'localhost:5000',
  hostScheme: 'https',
  apiVersion: '2024-01',
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
          { new: true }
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
      res.status(500).send(error.message);
    }
  }
});

// For all other routes parse JSON body
app.use(express.json());

// 1. App Installation (Authentication) - Begin OAuth
app.get('/api/auth', async (req, res) => {
  const shop = req.query.shop;
  if (!shop) {
    return res.status(400).send('Missing shop parameter');
  }

  try {
    // Begins real authentication with Shopify Partners:
    await shopify.auth.begin({
      shop: shopify.utils.sanitizeShop(shop, true),
      callbackPath: '/api/auth/callback',
      isOnline: false,
      rawRequest: req,
      rawResponse: res,
    });
  } catch (error) {
    console.error('Error starting OAuth:', error);
    res.status(500).send('Failed to begin OAuth');
  }
});

// 2. Auth Callback
app.get('/api/auth/callback', async (req, res) => {
  try {
    const callbackResponse = await shopify.auth.callback({
      rawRequest: req,
      rawResponse: res,
    });
    
    // Extract the session from the callback
    const session = callbackResponse.session;
    
    // Store in our database
    await Shop.findOneAndUpdate(
      { shop: session.shop },
      { shop: session.shop, session, isInstalled: true },
      { upsert: true, new: true }
    );

    // Register webhooks after authenticating
    try {
      const response = await shopify.webhooks.register({ session });
      console.log('Webhooks registered:', response);
    } catch (e) {
      console.error('Failed to register webhooks', e);
    }

    // Send the user to the embedded app frontend
    const host = req.query.host;
    const redirectUrl = `/?shop=${session.shop}&host=${host}`;
    
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('OAuth Callback Error:', error);
    res.status(500).send('OAuth callback failed');
  }
});

// 3. API Endpoint to Get Order Count
app.get('/api/orders/count', async (req, res) => {
  try {
    const shop = shopify.utils.sanitizeShop(req.query.shop, true);
    
    if (!shop) {
       return res.status(400).json({ error: 'Missing shop parameter' });
    }

    let store = await Shop.findOne({ shop });
    
    if (!store || !store.session) {
      console.log(`[OrderCount] Store not found or session missing for: ${shop}`);
      // In development fallback if you want to see something, but better to enforce logout/re-auth
      return res.status(401).json({ error: 'Not authorized. Please login via Shopify Admin.' });
    }

    const session = store.session;

    // Use Shopify REST API to get the TOTAL order count
    const client = new shopify.clients.Rest({ session });
    const countResponse = await client.get({
      path: 'orders/count',
    });

    const totalCount = countResponse.body.count;
    console.log(`[OrderCount] Fetched real total count from Shopify: ${totalCount}`);

    // Update our DB with the latest count from Shopify
    store.orderCount = totalCount;
    await store.save();
    
    res.json({ count: totalCount });
  } catch (error) {
    console.error(`[OrderCount] Error fetching orders for ${req.query.shop}:`, error.message);
    res.status(500).json({ error: 'Failed' });
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

// Serve frontend in production
const isProd = process.env.NODE_ENV === 'production';
if (isProd) {
  const buildPath = path.join(__dirname, 'frontend', 'dist');
  app.use(express.static(buildPath));
  
  // Any request that doesn't match an API route gets the React App
  app.get('/*', (req, res) => {
    res.sendFile(path.join(buildPath, 'index.html'));
  });
}

const PORT = process.env.PORT || 5000;

if (process.env.NODE_ENV !== 'production') {
  app.listen(PORT, () => {
    console.log(`Backend server running on http://localhost:${PORT}`);
  });
}

export default app;
