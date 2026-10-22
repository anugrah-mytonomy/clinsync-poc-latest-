/**
 * The client's upload rules (Add Content design §Validation rules): allowed types, ZIP members, size limit, folder
 * depth. Fixed here — no GET /api/v1/uploads/config call. Keep in step with the server's ALLOWED_TOP_LEVEL_EXT,
 * ALLOWED_ZIP_ENTRY_EXT, MAX_UPLOAD_BYTES and MAX_ZIP_FOLDER_DEPTH; initiate refuses anything outside them.
 */
export interface UploadConfig {
  allowedTopLevelExt: string[];
  allowedZipEntryExt: string[];
  maxUploadBytes: number;
  maxZipFolderDepth: number;
}

export const UPLOAD_CONFIG: UploadConfig = {
  allowedTopLevelExt: ['docx', 'pdf', 'zip'],
  allowedZipEntryExt: ['docx', 'pdf'],
  maxUploadBytes: 5 * 1024 * 1024 * 1024, // 5 GiB
  maxZipFolderDepth: 1, // root or one folder
};
