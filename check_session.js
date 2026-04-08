import mongoose from 'mongoose';
import dotenv from 'dotenv';
import Shop from './models/Shop.js';

dotenv.config();

async function checkStore() {
  await mongoose.connect(process.env.MONGODB_URI);
  const shop = 'pxjd1q-at.myshopify.com';
  const store = await Shop.findOne({ shop });
  
  if (store) {
    console.log('Store found:', store.shop);
    console.log('Session exists:', !!store.session);
    if (store.session) {
        console.log('Access Token exists:', !!store.session.accessToken);
        console.log('Session Keys:', Object.keys(store.session));
    }
  } else {
    console.log('Store not found in DB:', shop);
  }
  process.exit(0);
}

checkStore();
