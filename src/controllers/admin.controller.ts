import type { Request, Response } from "express";
import { adminService } from "../services/admin.service.js";
import { sendSuccess } from "../utils/response.js";
import type { AdminUserListQuery, GenerationFailureQuery, PeriodQuery } from "../schemas/admin.schema.js";

export const adminController = {
    async listUsers(req: Request, res: Response) {
        sendSuccess(res, await adminService.listUsers(req.query as unknown as AdminUserListQuery));
    },

    async serviceStats(_req: Request, res: Response) {
        sendSuccess(res, await adminService.serviceStats());
    },

    async generationStats(req: Request, res: Response) {
        sendSuccess(res, await adminService.generationStats(req.query as unknown as PeriodQuery));
    },

    async generationFailures(req: Request, res: Response) {
        sendSuccess(res, await adminService.generationFailures(req.query as unknown as GenerationFailureQuery));
    },

    async reviewStats(req: Request, res: Response) {
        sendSuccess(res, await adminService.reviewStats(req.query as unknown as PeriodQuery));
    },
};
