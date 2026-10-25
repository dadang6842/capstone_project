import { createReadStream } from "node:fs";
import { DeleteObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { s3 } from "../config/s3.js";
import { env } from "../config/env.js";

// 임시 폴더에 받아 둔 파일을 스트림으로 올린다 (파일 전체를 메모리에 올리지 않음)
export async function uploadFile(params: { key: string; filePath: string; size: number; contentType: string }) {
    await s3.send(
        new PutObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: params.key,
            Body: createReadStream(params.filePath),
            ContentLength: params.size,
            ContentType: params.contentType,
        }),
    );
}

export async function deleteFile(key: string) {
    await s3.send(new DeleteObjectCommand({ Bucket: env.S3_BUCKET, Key: key }));
}
