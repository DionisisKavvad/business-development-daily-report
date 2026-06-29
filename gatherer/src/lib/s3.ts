import { S3Client, GetObjectCommand, PutObjectCommand, NoSuchKey } from '@aws-sdk/client-s3';
import * as fs from 'fs/promises';
import * as path from 'path';

const s3 = new S3Client({ region: process.env.AWS_REGION });
const BUCKET = process.env.BD_REPORT_BUCKET as string;
/** When set, read/write JSON from this local dir instead of S3 (local testing). */
const LOCAL_DIR = process.env.BD_LOCAL;

/** Read a JSON object from the report bucket, or null if it does not exist. */
export async function getJson<T = any>(key: string): Promise<T | null> {
  if (LOCAL_DIR) {
    try {
      const body = await fs.readFile(path.join(LOCAL_DIR, key), 'utf8');
      return JSON.parse(body) as T;
    } catch (err: any) {
      if (err?.code === 'ENOENT') return null;
      throw err;
    }
  }
  try {
    const res = await s3.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
    const body = await res.Body?.transformToString();
    return body ? (JSON.parse(body) as T) : null;
  } catch (err: any) {
    if (err instanceof NoSuchKey || err?.name === 'NoSuchKey' || err?.$metadata?.httpStatusCode === 404) {
      return null;
    }
    throw err;
  }
}

/** Write a JSON object to the report bucket (private, SSE). */
export async function putJson(key: string, value: unknown): Promise<void> {
  if (LOCAL_DIR) {
    const file = path.join(LOCAL_DIR, key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, JSON.stringify(value, null, 2));
    return;
  }
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(value),
      ContentType: 'application/json',
      ServerSideEncryption: 'AES256',
    })
  );
}
