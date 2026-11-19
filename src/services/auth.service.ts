import bcrypt from "bcrypt";
import { Prisma, type User } from "../generated/prisma/client.js";
import { userRepository } from "../repositories/user.repository.js";
import { refreshTokenRepository } from "../repositories/refreshToken.repository.js";
import { AppError } from "../utils/appError.js";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../utils/jwt.js";
import { verifyGoogleIdToken, type GoogleProfile } from "../utils/googleAuth.js";
import type {
    SignupBody,
    LoginBody,
    LoginResponse,
    RefreshTokenBody,
    TokenResponse,
    UserResponse,
    GoogleLoginBody,
    GoogleLoginResponse,
} from "../schemas/auth.schema.js";

export const BCRYPT_ROUNDS = 10;
const NICKNAME_MAX = 12;

// 회원 정보 응답 (로그인 응답의 user, 내 정보 조회 등에서 같이 쓴다)
export function toUserResponse(user: User): UserResponse {
    return {
        userId: Number(user.userId),
        email: user.email,
        nickname: user.nickname,
        role: user.role,
        createdAt: user.createdAt,
        hasPassword: user.password !== null,
        googleLinked: user.googleSub !== null,
    };
}

// 로그인·회원가입 공통: 토큰을 발급하고 refresh 토큰을 저장한 뒤 응답 형태로 만든다
export async function issueTokens(user: User): Promise<LoginResponse> {
    const userId = Number(user.userId);
    const accessToken = signAccessToken({ userId, role: user.role });
    const refresh = signRefreshToken(userId);
    await refreshTokenRepository.create({ userId: user.userId, token: refresh.token, expiresAt: refresh.expiresAt });

    return { user: toUserResponse(user), accessToken, refreshToken: refresh.token };
}

// 비밀번호 확인. 구글로만 가입한 회원(password NULL)은 항상 불일치로 처리한다 (회원 탈퇴 USER-04에서도 사용)
export async function passwordMatches(user: User, password: string) {
    return user.password !== null && (await bcrypt.compare(password, user.password));
}

// 구글 가입 시 닉네임: 구글 이름 → 없으면 이메일 @ 앞부분. 12자를 넘으면 자른다 (가입 후 A08에서 수정 가능)
function nicknameFromGoogle({ name, email }: GoogleProfile) {
    const base = name || email.split("@")[0].trim() || "사용자";
    return Array.from(base).slice(0, NICKNAME_MAX).join("").trim() || "사용자";
}

// 같은 이메일로 이미 가입한 계정이 있을 때. 이메일만 보고 자동으로 합치지 않는다 (다현 결정 2026-11-19)
// 그 계정으로 로그인한 뒤 계정 정보(A08)에서 구글을 연결해야 한다
const EMAIL_REGISTERED_MESSAGE =
    "이미 이 이메일로 가입한 계정이 있습니다. 이메일로 로그인한 뒤 계정 정보에서 구글 계정을 연결해 주세요.";

function createGoogleUser(google: GoogleProfile) {
    return userRepository.create({
        email: google.email,
        password: null,
        nickname: nicknameFromGoogle(google),
        googleSub: google.sub,
    });
}

export const authService = {
    async signup({ email, password, nickname }: SignupBody): Promise<LoginResponse> {
        // 탈퇴 유예 중인 계정, 구글로 가입한 계정도 행이 남아 있으므로 여기서 같이 걸린다
        if (await userRepository.findByEmail(email)) throw new AppError("EMAIL_DUPLICATED");

        const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
        try {
            const user = await userRepository.create({ email, password: hashed, nickname });
            return await issueTokens(user);
        } catch (err) {
            // 같은 이메일로 동시에 가입하면 위 확인을 둘 다 통과할 수 있어서, DB UNIQUE 위반(P2002)도 중복으로 처리
            if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
                throw new AppError("EMAIL_DUPLICATED");
            }
            throw err;
        }
    },

    async login({ email, password }: LoginBody): Promise<LoginResponse> {
        const user = await userRepository.findByEmail(email);

        // 이메일이 없을 때와 비밀번호가 틀릴 때 같은 에러 (어느 쪽이 틀렸는지 알려 주지 않음)
        if (!user || !(await passwordMatches(user, password))) throw new AppError("INVALID_CREDENTIALS");

        // 탈퇴 유예 중 (deleted_at이 있으면 7일 유예 기간)
        if (user.deletedAt) {
            throw new AppError("WITHDRAWAL_PENDING", { details: { withdrawalRequestedAt: user.deletedAt } });
        }

        return issueTokens(user);
    },

    // 탈퇴 유예 중 로그인했을 때(403 WITHDRAWAL_PENDING) 프론트가 확인 팝업 후 호출한다
    async cancelWithdrawal({ email, password }: LoginBody): Promise<LoginResponse> {
        const user = await userRepository.findByEmail(email);
        if (!user || !(await passwordMatches(user, password))) throw new AppError("INVALID_CREDENTIALS");
        if (!user.deletedAt) throw new AppError("WITHDRAWAL_NOT_REQUESTED");

        const restored = await userRepository.update(user.userId, { deletedAt: null });
        return issueTokens(restored);
    },

    // 구글 로그인(AUTH-07): 구글 계정(sub)이 연결된 회원이면 로그인, 처음 보는 구글 계정이면 가입
    // 같은 이메일로 가입한 다른 계정이 있으면 합치지 않고 409 EMAIL_DUPLICATED
    async googleLogin({ idToken }: GoogleLoginBody): Promise<GoogleLoginResponse> {
        const google = await verifyGoogleIdToken(idToken);

        let user = await userRepository.findByGoogleSub(google.sub);
        let isNewUser = false;
        if (!user) {
            if (await userRepository.findByEmail(google.email)) {
                throw new AppError("EMAIL_DUPLICATED", { message: EMAIL_REGISTERED_MESSAGE });
            }
            try {
                user = await createGoogleUser(google);
                isNewUser = true;
            } catch (err) {
                if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
                // 같은 구글 계정으로 동시에 눌러서 다른 요청이 먼저 만들었으면 그 회원으로 로그인
                user = await userRepository.findByGoogleSub(google.sub);
                if (!user) throw new AppError("EMAIL_DUPLICATED", { message: EMAIL_REGISTERED_MESSAGE });
            }
        }

        // 탈퇴 유예 중이면 이메일 로그인과 같은 403. 프론트는 확인 후 AUTH-08로 취소
        if (user.deletedAt) {
            throw new AppError("WITHDRAWAL_PENDING", { details: { withdrawalRequestedAt: user.deletedAt } });
        }

        return { ...(await issueTokens(user)), isNewUser };
    },

    // 구글 계정 탈퇴 취소(AUTH-08): AUTH-07에서 403 WITHDRAWAL_PENDING을 받은 뒤 같은 구글 ID 토큰으로 호출
    // 이 구글 계정이 연결된 회원만 찾는다 (이메일로 찾지 않음)
    async cancelWithdrawalWithGoogle({ idToken }: GoogleLoginBody): Promise<LoginResponse> {
        const google = await verifyGoogleIdToken(idToken);
        const user = await userRepository.findByGoogleSub(google.sub);
        if (!user?.deletedAt) throw new AppError("WITHDRAWAL_NOT_REQUESTED");

        const restored = await userRepository.update(user.userId, { deletedAt: null });
        return issueTokens(restored);
    },

    async refresh({ refreshToken }: RefreshTokenBody): Promise<TokenResponse> {
        // 1) 서명·만료 확인
        try {
            verifyRefreshToken(refreshToken);
        } catch {
            throw new AppError("INVALID_TOKEN");
        }

        // 2) DB 확인: 저장된 토큰인지, 로그아웃(폐기)·만료되지 않았는지, 탈퇴 유예 중이 아닌지
        const saved = await refreshTokenRepository.findByTokenWithUser(refreshToken);
        if (!saved || saved.revokedAt || saved.expiresAt <= new Date() || saved.user.deletedAt) {
            throw new AppError("INVALID_TOKEN");
        }

        // 3) 토큰 회전: 기존 refresh 토큰은 폐기하고 새 토큰 쌍을 준다
        const userId = Number(saved.userId);
        const next = signRefreshToken(userId);
        const rotated = await refreshTokenRepository.rotate(refreshToken, {
            userId: saved.userId,
            token: next.token,
            expiresAt: next.expiresAt,
        });
        if (!rotated) throw new AppError("INVALID_TOKEN"); // 동시에 들어온 다른 요청이 먼저 썼음

        return { accessToken: signAccessToken({ userId, role: saved.user.role }), refreshToken: next.token };
    },

    // 현재 기기의 refresh 토큰만 폐기한다. 이미 폐기됐거나 없는 토큰이어도 성공으로 처리한다.
    async logout(userId: number, { refreshToken }: RefreshTokenBody) {
        await refreshTokenRepository.revoke(refreshToken, BigInt(userId));
    },
};
