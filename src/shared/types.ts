/** API payload types shared by the Worker and the web app. */

export type Role = "admin" | "member";
export type MemberStatus = "invited" | "active" | "disabled";

export interface Me {
  user: { id: string; email: string; name: string | null; role: Role; quotaBytes: number };
  csrfToken: string;
  limits: { maxUploadBytes: number };
}

export interface FileItem {
  id: string;
  kind: "file";
  name: string;
  size: number;
  contentType: string;
  inline: boolean;
  folderId: string | null;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
  isOwner: boolean;
  owner: { id: string; email: string; name: string | null };
  sharedWithCount: number;
  hasPublicLink: boolean;
}

export interface FolderItem {
  id: string;
  kind: "folder";
  name: string;
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  trashedAt: number | null;
}

export type DriveItem = FileItem | FolderItem;

export interface FolderListing {
  folder: FolderItem | null;
  breadcrumb: { id: string; name: string }[];
  folders: FolderItem[];
  files: FileItem[];
  truncated: boolean;
}

export interface Sharing {
  fileId: string;
  visibility: "private" | "public";
  members: { id: string; email: string; name: string | null; grantedAt: number }[];
  publicLink: { url: string; createdAt: number } | null;
}

export interface MemberLite {
  id: string;
  email: string;
  name: string | null;
}

export interface Member extends MemberLite {
  role: Role;
  status: MemberStatus;
  quotaBytes: number;
  createdAt: number;
  lastLoginAt: number | null;
}

export interface StorageTargetInfo {
  id: string;
  name: string;
  accountId: string;
  bucket: string;
  credentialRef: string;
  credentialsPresent: boolean;
  acceptingUploads: boolean;
  lastCheckAt: number | null;
  lastCheckOk: boolean | null;
  lastCheckMessage: string | null;
  createdAt: number;
  isDefault: boolean;
  references: { files: number; uploadSessions: number };
}

export interface StorageCheck {
  ok: boolean;
  credentials: boolean;
  write: boolean;
  read: boolean;
  delete: boolean;
  cors: boolean;
  message: string;
}

export interface UploadTicket {
  uploadId: string;
  putUrl: string;
  putHeaders: Record<string, string>;
  expiresAt: number;
  maxBytes: number;
}

export interface AuditEvent {
  id: string;
  actorUserId: string | null;
  action: string;
  resourceType: string;
  resourceId: string;
  metadata: string | null;
  createdAt: number;
}

export interface ApiErrorBody {
  error: { code: string; message: string; [k: string]: unknown };
}
