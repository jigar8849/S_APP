import mongoose from 'mongoose';

const ShopSchema = new mongoose.Schema({
  shop: { type: String, required: true, unique: true },
  session: { type: Object }, // Store the Shopify session object here
  orderCount: { type: Number, default: 0 },
  isInstalled: { type: Boolean, default: false }
}, { timestamps: true });

export default mongoose.model('Shop', ShopSchema);
