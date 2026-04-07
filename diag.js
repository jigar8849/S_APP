import dotenv from 'dotenv';
import mongoose from 'mongoose';
dotenv.config();

console.log('MONGODB_URI found:', !!process.env.MONGODB_URI);
if (process.env.MONGODB_URI) {
    const uri = process.env.MONGODB_URI;
    const maskedUri = uri.replace(/:([^@]+)@/, ':****@');
    console.log('Connection String (masked):', maskedUri);
    
    console.log('Testing connection...');
    mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 })
        .then(() => {
            console.log('✅ Success! Connected to MongoDB.');
            process.exit(0);
        })
        .catch(err => {
            console.error('❌ Failed! MongoDB Error:', err.message);
            process.exit(1);
        });
} else {
    console.error('❌ MONGODB_URI not found in .env');
    process.exit(1);
}
