// test_mongo.js
require('dotenv').config(); // Pastikan Anda memiliki file .env dengan MONGODB_URI

const { MongoClient } = require('mongodb');
const uri = process.env.MONGODB_URI;
const dbName = process.env.MONGODB_DB_NAME;

async function testConnection() {
    if (!uri || !dbName) {
        console.error("MONGODB_URI or MONGODB_DB_NAME not set in .env");
        return;
    }

    console.log("Attempting to connect to MongoDB Atlas...");
    const client = new MongoClient(uri, {
        serverSelectionTimeoutMS: 10000 // Beri waktu lebih lama untuk testing
    });

    try {
        await client.connect();
        console.log("✅ Successfully connected to MongoDB Atlas!");
        const db = client.db(dbName);
        console.log(`Connected to database: ${db}`);

        // Coba lakukan operasi sederhana
        const usersCollection = db.collection('users');
        const result = await usersCollection.insertOne({ test: "Hello World", timestamp: new Date() });
        console.log("✅ Successfully inserted a test document:", result.insertedId);

    } catch (err) {
        console.error("❌ Failed to connect or perform operation:", err.message);
        console.error("Full error:", err); // Log error lengkap
    } finally {
        await client.close(); // Pastikan klien ditutup
        console.log("Connection closed.");
    }
}

testConnection();