const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { fromEnv } = require("@aws-sdk/credential-provider-env");
require("dotenv").config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: fromEnv(),
  maxAttempts: 1
});

module.exports = {
  // New download function
  async downloadFile(fileName) {
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileName
    };

    try {
      const { Body } = await s3Client.send(new GetObjectCommand(params));
      return Buffer.from(await Body.transformToByteArray());
    } catch (err) {
      console.error(`❌ Failed to download ${fileName}:`, err);
      throw err;
    }
  }
};
