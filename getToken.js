import mongoose from 'mongoose';
import dotenv from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, '.env') });

const ShopSchema = new mongoose.Schema({
  shop: String,
  session: Object
}, { strict: false });

const Shop = mongoose.model('Shop', ShopSchema);

async function getTokens() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/shopify_order_app', {
      serverSelectionTimeoutMS: 5000
    });
    
    const shops = await Shop.find({});
    
    if (shops.length === 0) {
      console.log('No shops found in the database. Have you installed the app yet?');
    } else {
      console.log('--- Access Tokens ---');
      shops.forEach(store => {
        if (store.session && store.session.accessToken) {
          console.log(`Store: ${store.shop}`);
          console.log(`Access Token: ${store.session.accessToken}`);
          console.log('---------------------');
        } else {
          console.log(`Store: ${store.shop} (No session or access token found)`);
          console.log('---------------------');
        }
      });
    }
    
    await mongoose.disconnect();
  } catch (error) {
    console.error('Error fetching tokens:', error);
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
  }
}

getTokens();
