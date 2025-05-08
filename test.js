const { 
  S3Client, 
  ListBucketsCommand, 
  PutObjectCommand,
  DeleteObjectCommand 
} = require("@aws-sdk/client-s3");
require("dotenv").config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: {
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY
  }
});

async function testS3() {
  try {
    // List buckets
    const buckets = await s3Client.send(new ListBucketsCommand({}));
    console.log("Buckets:", buckets.Buckets.map(b => b.Name));

    // Upload test file
    await s3Client.send(new PutObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: "test-file.txt",
      Body: "Test content",
      ContentType: "text/plain"
    }));
    console.log("✅ Upload successful");

    // Cleanup
    await s3Client.send(new DeleteObjectCommand({
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: "test-file.txt"
    }));
    console.log("🧹 Cleanup successful");

  } catch (err) {
    console.error("❌ Error:", err.message);
  }
}

testS3();