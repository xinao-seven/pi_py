import type { FastifyPluginAsync } from "fastify";

import { ApiError } from "../errors.js";
import { FileService } from "../services/file-service.js";

export const fileRoutes: FastifyPluginAsync<{ service: FileService }> = async (app, options) => {
  app.get<{ Params: { "*": string }; Querystring: { root?: string; type?: string } }>("/*", async (request, reply) => {
    const root = request.query.root;
    if (!root) throw new ApiError(422, "validation_error", "root is required");
    const path = request.params["*"] ?? "";
    switch (request.query.type ?? "list") {
      case "list": return options.service.list(path, root);
      case "read": return options.service.readText(path, root);
      case "media": {
        const media = await options.service.media(path, root);
        return reply.type(media.mimeType).send(media.content);
      }
      default: throw new ApiError(422, "validation_error", "type must be list, read, or media");
    }
  });
};
