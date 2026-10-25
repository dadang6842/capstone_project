import { S3Client } from "@aws-sdk/client-s3";
import { env } from "./env.js";

// 자격 증명은 SDK가 알아서 찾는다
//  - 로컬: .env의 AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
//  - EC2: 인스턴스에 붙인 IAM 역할 (키를 .env에 넣지 않아도 됨)
export const s3 = new S3Client({ region: env.AWS_REGION });
