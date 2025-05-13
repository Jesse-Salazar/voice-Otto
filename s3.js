const { S3Client, PutObjectCommand, GetObjectCommand } = require("@aws-sdk/client-s3");
const { fromEnv } = require("@aws-sdk/credential-provider-env");
require("dotenv").config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: fromEnv()
});

module.exports = {
  // Existing upload function
  async uploadFile(buffer, fileName, contentType) {
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: contentType
    };

    try {
      await s3Client.send(new PutObjectCommand(params));
      console.log(`✅ Uploaded ${fileName}`);
      return `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
    } catch (err) {
      console.error(`❌ Failed to upload ${fileName}:`, err);
      throw err;
    }
  },

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