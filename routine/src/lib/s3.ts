import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.BD_REPORT_BUCKET as string;

export async function getText(key: string): Promise<string> {
  const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  const body = await res.Body?.transformToString();
  if (!body) throw new Error(`empty object: ${key}`);
  return body;
}

export async function putHtml(key: string, html: string): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: html,
      ContentType: 'text/html; charset=utf-8',
      ServerSideEncryption: 'AES256',
    })
  );
}

/** Presigned GET URL valid for `days` (default 7). */
export async function presign(key: string, days = 7): Promise<string> {
  return getSignedUrl(s3, new GetObjectCommand({ Bucket: BUCKET, Key: key }), {
    expiresIn: days * 24 * 60 * 60,
  });
}
