import type { Request, Response } from "express";
import { authService } from "../services/auth.service.js";
import { sendSuccess } from "../utils/response.js";
import type { LoginBody } from "../schemas/auth.schema.js";

export const authController = {
    async login(req: Request, res: Response) {
        const result = await authService.login(req.body as LoginBody);
        sendSuccess(res, result);
    },
};
