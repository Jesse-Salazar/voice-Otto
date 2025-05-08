const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const { fromEnv } = require("@aws-sdk/credential-provider-env");
require("dotenv").config();

const s3Client = new S3Client({
  region: process.env.AWS_REGION,
  credentials: fromEnv()
});

module.exports = {
  async uploadFile(buffer, fileName, contentType) {
    const params = {
      Bucket: process.env.AWS_BUCKET_NAME,
      Key: fileName,
      Body: buffer,
      ContentType: contentType
    };

    try {
      // The 'data' contains metadata like ETag, useful for verification
      const data = await s3Client.send(new PutObjectCommand(params));
      
      // Add logging to verify successful uploads
      console.log(`✅ Uploaded ${fileName}`); //(ETag: ${data.ETag})`);
      
      return `https://${params.Bucket}.s3.${process.env.AWS_REGION}.amazonaws.com/${fileName}`;
    } catch (err) {
      // Enhance error context
      console.error(`❌ Failed to upload ${fileName}:`, err);
      throw err;
    }
  }
};