import { createReadStream } from "node:fs";
import { DeleteObjectCommand, GetObjectCommand, PutObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
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

// 원본 열람용 Presigned URL (10분 유효). AWS에 요청하지 않고 서버 안에서 서명만 계산한다
// inline이라 브라우저가 내려받지 않고 바로 보여 주고, 저장할 때는 원래 파일명을 쓴다
export function getViewUrl(key: string, filename: string) {
    return getSignedUrl(
        s3,
        new GetObjectCommand({
            Bucket: env.S3_BUCKET,
            Key: key,
            ResponseContentDisposition: `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
        }),
        { expiresIn: 600 },
    );
}
