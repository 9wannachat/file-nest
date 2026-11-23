import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { stat } from "node:fs/promises";
import { basename, extname } from "node:path";
import { z } from "zod";
import { ApiError, type FileItem, type FileNestClient, type FolderItem } from "./client.js";
import { safeFileName, SandboxError, type Workdir } from "./sandbox.js";

export const MAX_TEXT_BYTES = 1024 * 1024;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

const MIME: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".csv": "text/csv",
  ".json": "application/json",
  ".srt": "text/plain",
  ".vtt": "text/vtt",
};

const fileSummary = (f: FileItem) => ({
  id: f.id,
  name: f.name,
  size: f.size,
  contentType: f.contentType,
  folderId: f.folderId,
  owner: f.isOwner ? "me" : (f.owner.email ?? f.owner.id),
  updatedAt: new Date(f.updatedAt).toISOString(),
});
const folderSummary = (f: FolderItem) => ({ id: f.id, name: f.name, parentId: f.parentId });

const ok = (data: unknown): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });

async function guard(fn: () => Promise<CallToolResult>): Promise<CallToolResult> {
  try {
    return await fn();
  } catch (e) {
    const msg =
      e instanceof ApiError
        ? `FileNest error ${e.status} (${e.code}): ${e.message}`
        : e instanceof SandboxError
          ? `Not allowed: ${e.message}`
          : `Error: ${(e as Error).message}`;
    return { isError: true, content: [{ type: "text", text: msg }] };
  }
}

const id = z.string().uuid();

export function createServer(client: FileNestClient, workdir: Workdir) {
  const server = new McpServer(
    { name: "filenest", version: "0.1.0" },
    {
      instructions:
        `Access the user's FileNest drive. Typical workflow for local processing (e.g. video editing with ffmpeg): ` +
        `find a file (search_files / list_folder), download_file into the working folder (${workdir.root}), process it locally, ` +
        `then upload_file the result. Local paths are relative to the working folder; other locations are refused. ` +
        `This server cannot share, delete or move files.`,
    },
  );

  server.registerTool(
    "list_folder",
    {
      title: "List folder",
      description: "List folders and files in a FileNest folder you own. Omit folderId for My Drive (root).",
      inputSchema: { folderId: id.optional().describe("Folder id; omit for root") },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ folderId }) =>
      guard(async () => {
        const r = await client.listFolder(folderId ?? null);
        return ok({
          folder: r.folder ? folderSummary(r.folder) : { id: null, name: "My Drive" },
          path: r.breadcrumb.map((b) => b.name).join(" / ") || "/",
          folders: r.folders.map(folderSummary),
          files: r.files.map(fileSummary),
        });
      }),
  );

  server.registerTool(
    "search_files",
    {
      title: "Search files",
      description: "Search file and folder names (yours and files shared with you).",
      inputSchema: { query: z.string().min(1).max(100) },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ query }) =>
      guard(async () => {
        const r = await client.search(query);
        return ok({ folders: r.folders.map(folderSummary), files: r.files.map(fileSummary) });
      }),
  );

  server.registerTool(
    "list_shared",
    {
      title: "Files shared with me",
      description: "List files other members shared with you (read and download only).",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    () => guard(async () => ok({ files: (await client.shared()).files.map(fileSummary) })),
  );

  server.registerTool(
    "get_file_info",
    {
      title: "File info",
      description: "Get name, size, type and dates of a file.",
      inputSchema: { fileId: id },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ fileId }) => guard(async () => ok(fileSummary(await client.fileInfo(fileId)))),
  );

  server.registerTool(
    "read_file_content",
    {
      title: "Read file content",
      description: `Return a small file directly to the assistant without saving it: text (≤ ${MAX_TEXT_BYTES / 1024} KB) or PNG/JPEG/GIF/WebP images (≤ ${MAX_IMAGE_BYTES / 1024 / 1024} MB). Use download_file for anything else.`,
      inputSchema: { fileId: id },
      annotations: { readOnlyHint: true, openWorldHint: false },
    },
    ({ fileId }) =>
      guard(async () => {
        const f = await client.fileInfo(fileId);
        const type = f.contentType.split(";")[0]!.trim();
        if (type.startsWith("text/") || type === "application/json") {
          const bytes = await client.readBytes(f.id, Math.min(MAX_TEXT_BYTES, Math.max(1, f.size)));
          const text = new TextDecoder("utf-8", { fatal: false }).decode(bytes);
          const note = f.size > MAX_TEXT_BYTES ? `\n\n[truncated: showing first ${MAX_TEXT_BYTES} of ${f.size} bytes]` : "";
          return { content: [{ type: "text", text: text + note }] };
        }
        if (IMAGE_TYPES.has(type)) {
          if (f.size > MAX_IMAGE_BYTES) throw new ApiError(413, "too_large", "Image is too large to inline; use download_file");
          const bytes = await client.readBytes(f.id, Math.max(1, f.size));
          return { content: [{ type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: type }] };
        }
        throw new ApiError(415, "not_inline", `Type ${type} cannot be returned inline; use download_file`);
      }),
  );

  server.registerTool(
    "download_file",
    {
      title: "Download file",
      description:
        "Download a FileNest file into the local working folder so local tools can process it. Resumes an interrupted download. Returns the absolute local path.",
      inputSchema: {
        fileId: id,
        path: z.string().max(500).optional().describe("Relative path inside the working folder; defaults to the file name"),
        overwrite: z.boolean().optional().describe("Replace an existing local file"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ fileId, path, overwrite }) =>
      guard(async () => {
        const f = await client.fileInfo(fileId);
        const dest = await workdir.writable(path ?? safeFileName(f.name), overwrite ?? false);
        const r = await client.download(f.id, dest, { size: f.size });
        return ok({ localPath: dest, relativePath: workdir.rel(dest), bytes: r.bytes, resumed: r.resumed, contentType: f.contentType });
      }),
  );

  server.registerTool(
    "upload_file",
    {
      title: "Upload file",
      description: "Upload a file from the local working folder to FileNest (e.g. an edited result). New files are private.",
      inputSchema: {
        path: z.string().max(500).describe("Relative path inside the working folder"),
        folderId: id.optional().describe("Destination folder id; omit for My Drive"),
        name: z.string().min(1).max(255).optional().describe("Name in FileNest; defaults to the local file name"),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ path, folderId, name }) =>
      guard(async () => {
        const src = await workdir.readable(path);
        const size = (await stat(src)).size;
        const me = await client.me();
        if (size > me.limits.maxUploadBytes) {
          throw new ApiError(413, "file_too_large", `File is ${size} bytes; the server limit is ${me.limits.maxUploadBytes}`);
        }
        const mime = MIME[extname(src).toLowerCase()] ?? "application/octet-stream";
        const file = await client.upload(src, name ?? basename(src), size, mime, folderId ?? null);
        return ok({ uploaded: fileSummary(file) });
      }),
  );

  server.registerTool(
    "create_folder",
    {
      title: "Create folder",
      description: "Create a folder in FileNest (inside parentId, or My Drive).",
      inputSchema: { name: z.string().min(1).max(255), parentId: id.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    ({ name, parentId }) => guard(async () => ok(folderSummary(await client.createFolder(name, parentId ?? null)))),
  );

  return server;
}
