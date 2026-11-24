/** API payload types shared by the Worker and the web app. */

export type Role = "admin" | "member";
export type MemberStatus = "invited" | "active" | "disabled";

export interface Me {
  user: { id: string; email: string; name: string | null; role: Role; quotaBytes: number; usedBytes: number; trashedBytes?: number; quotaUnlimited?: boolean };
  auth?: "session" | "token";
  mfa?: { enabled: boolean; setupRequired: boolean; required: boolean };
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
  publicLink: { url: string; createdAt: number; passwordProtected: boolean } | null;
  policy?: { publicLinksEnabled: boolean; requirePassword: boolean };
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
  quotaUnlimited?: boolean;
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
  capacityBytes: number | null;
  priority: number;
  order: number;
  usedBytes: number;
  reservedBytes: number;
  freeBytes: number | null;
  eligible: boolean;
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

export interface ApiTokenInfo {
  id: string;
  name: string;
  scopes: ("files:read" | "files:write")[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number;
  revokedAt: number | null;
}

export type SignInProvider = "google" | "microsoft" | "github";
export const SIGN_IN_PROVIDERS: SignInProvider[] = ["google", "microsoft", "github"];
export const PROVIDER_LABELS: Record<SignInProvider, string> = { google: "Google", microsoft: "Microsoft", github: "GitHub" };

export interface AuthConfig {
  google: boolean;
  microsoft: boolean;
  github: boolean;
  password: boolean;
  registration: "invite" | "closed";
}

export interface AccountInfo {
  email: string;
  name: string | null;
  hasPassword: boolean;
  identities: SignInProvider[];
  /** Providers the member could connect right now (enabled and configured). */
  availableProviders: SignInProvider[];
  mfa: { enabled: boolean; enabledAt: number | null; required: boolean; recoveryCodesRemaining: number };
  passwordUpdatedAt: number | null;
  reauthUntil: number | null;
  sessions: { id: string; createdAt: number; lastSeenAt: number; authMethod: string | null; userAgent: string | null; current: boolean }[];
}

export interface SystemSettings {
  registrationMode: "invite" | "closed";
  googleEnabled: boolean;
  microsoftEnabled: boolean;
  githubEnabled: boolean;
  passwordEnabled: boolean;
  mfaPolicy: "optional" | "admins" | "all";
  defaultQuotaBytes: number;
  maxUploadBytes: number;
  sessionTtlDays: number;
  trashRetentionDays: number;
  publicLinksEnabled: boolean;
  publicLinksRequirePassword: boolean;
}

export interface AdminMember extends Member {
  hasPassword: boolean;
  identities: SignInProvider[];
  mfaEnabled: boolean;
  bannedReason: string | null;
  bannedUntil: number | null;
  usedBytes: number;
  fileCount: number;
  sessionCount: number;
}

export interface InvitationInfo {
  id: string;
  email: string | null;
  role: Role;
  quotaBytes: number | null;
  maxUses: number;
  useCount: number;
  note: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  state: "active" | "revoked" | "expired" | "used_up";
  url: string | null;
}
