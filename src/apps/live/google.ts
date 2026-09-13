import { Readable } from 'node:stream';
import { google } from 'googleapis';
import type { calendar_v3, docs_v1, drive_v3, gmail_v1 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';
import type { Apps, CalendarAttendee, CalendarEvent, DriveFile, DrivePermission, GmailMessage, OutgoingEmail } from '../types.js';
import { FOLDER_MIME } from '../types.js';
import { sha256 } from '../../util.js';
import { base64url, buildRawEmail, decodeBase64url, parseRawEmail } from './mime.js';

// Live Gmail, Calendar, Drive, Docs and Sheets clients (PRD 6, 7.1, 7.5). `rootUrl` is the same
// override an Arga twin base URL uses, so this code runs unchanged against the twins and the real
// APIs. Least privilege (7.5): only the methods the Apps interfaces expose are called.

export interface GoogleAppsOptions {
  /** An OAuth2Client with valid credentials, or a bare bearer access token. */
  auth: OAuth2Client | string;
  /** Arga twin base URL override; omitted for the real Google APIs. */
  rootUrl?: string;
  /** The founder's own address, used as the `From` on sends built locally. */
  owner: string;
}

function resolveAuth(auth: OAuth2Client | string): OAuth2Client {
  if (typeof auth === 'string') {
    const client = new google.auth.OAuth2();
    client.setCredentials({ access_token: auth });
    return client;
  }
  return auth;
}

function escapeDriveQueryValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
}

function mapEvent(e: calendar_v3.Schema$Event): CalendarEvent {
  const attendees: CalendarAttendee[] = (e.attendees ?? []).map((a) => ({
    email: a.email ?? '',
    displayName: a.displayName ?? undefined,
    responseStatus: (a.responseStatus as CalendarAttendee['responseStatus']) ?? 'needsAction',
    self: a.self ?? undefined,
  }));
  return {
    id: e.id ?? '',
    summary: e.summary ?? '',
    description: e.description ?? '',
    location: e.location ?? undefined,
    start: e.start?.dateTime ?? e.start?.date ?? '',
    end: e.end?.dateTime ?? e.end?.date ?? '',
    status: (e.status as CalendarEvent['status']) ?? 'confirmed',
    organizer: e.organizer?.email ? { email: e.organizer.email, displayName: e.organizer.displayName ?? undefined } : undefined,
    attendees,
    htmlLink: e.htmlLink ?? undefined,
    updated: e.updated ?? '',
  };
}

function mapDriveFile(f: drive_v3.Schema$File): DriveFile {
  return {
    id: f.id ?? '',
    name: f.name ?? '',
    mimeType: f.mimeType ?? '',
    parents: f.parents ?? [],
    size: f.size ? Number(f.size) : 0,
    sha256: f.sha256Checksum ?? null,
    createdTime: f.createdTime ?? '',
    modifiedTime: f.modifiedTime ?? '',
    appProperties: (f.appProperties as Record<string, string>) ?? {},
  };
}

const DRIVE_FILE_FIELDS = 'id,name,mimeType,parents,size,sha256Checksum,createdTime,modifiedTime,appProperties';

export function createGoogleApps(opts: GoogleAppsOptions): Pick<Apps, 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets'> {
  const auth = resolveAuth(opts.auth);
  const base = { auth, rootUrl: opts.rootUrl };
  const gmail = google.gmail({ version: 'v1', ...base });
  const calendar = google.calendar({ version: 'v3', ...base });
  const drive = google.drive({ version: 'v3', ...base });
  const docs = google.docs({ version: 'v1', ...base });
  const sheets = google.sheets({ version: 'v4', ...base });

  return {
    gmail: {
      async listMessages(): Promise<GmailMessage[]> {
        const ids: gmail_v1.Schema$Message[] = [];
        let pageToken: string | undefined;
        do {
          const res = await gmail.users.messages.list({ userId: 'me', q: '-in:spam -in:trash', maxResults: 100, pageToken });
          ids.push(...(res.data.messages ?? []));
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);

        const out: GmailMessage[] = [];
        for (const ref of ids) {
          if (!ref.id) continue;
          const res = await gmail.users.messages.get({ userId: 'me', id: ref.id, format: 'raw' });
          const rawB64 = res.data.raw;
          if (!rawB64) continue;
          const raw = decodeBase64url(rawB64);
          const parsed = parseRawEmail(raw);
          const h = parsed.headers;
          out.push({
            id: res.data.id ?? ref.id,
            threadId: res.data.threadId ?? ref.threadId ?? res.data.id ?? ref.id,
            from: h['From'] ?? '',
            to: (h['To'] ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            date: h['Date'] ?? '',
            subject: h['Subject'] ?? '',
            body: parsed.body,
            headers: h,
            labels: res.data.labelIds ?? [],
            raw,
          });
        }
        return out.sort((a, b) => Date.parse(a.date) - Date.parse(b.date));
      },
      async send(email: OutgoingEmail) {
        const raw = base64url(buildRawEmail({ from: opts.owner, to: email.to, subject: email.subject, body: email.body, inReplyTo: email.inReplyTo }));
        const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw, threadId: email.threadId } });
        return { id: res.data.id ?? '', threadId: res.data.threadId ?? email.threadId ?? res.data.id ?? '' };
      },
    },
    calendar: {
      async listEvents(): Promise<CalendarEvent[]> {
        const timeMin = new Date(Date.now() - 3 * 365 * 86_400_000).toISOString();
        const timeMax = new Date(Date.now() + 365 * 86_400_000).toISOString();
        const events: calendar_v3.Schema$Event[] = [];
        let pageToken: string | undefined;
        do {
          const res = await calendar.events.list({ calendarId: 'primary', singleEvents: true, timeMin, timeMax, maxResults: 2500, pageToken, orderBy: 'startTime' });
          events.push(...(res.data.items ?? []));
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        return events.map(mapEvent);
      },
    },
    drive: {
      async findChild(parentId, name) {
        const parent = parentId ?? 'root';
        const q = `name = '${escapeDriveQueryValue(name)}' and '${parent}' in parents and trashed = false`;
        const res = await drive.files.list({ q, fields: `files(${DRIVE_FILE_FIELDS})`, pageSize: 1 });
        const f = res.data.files?.[0];
        return f ? mapDriveFile(f) : null;
      },
      async createFolder(parentId, name) {
        const res = await drive.files.create({
          requestBody: { name, mimeType: FOLDER_MIME, parents: [parentId ?? 'root'] },
          fields: DRIVE_FILE_FIELDS,
        });
        return mapDriveFile(res.data);
      },
      async createFile({ parentId, name, mimeType, content, appProperties }) {
        const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
        const res = await drive.files.create({
          requestBody: { name, parents: [parentId], appProperties },
          media: { mimeType, body: Readable.from(bytes) },
          fields: DRIVE_FILE_FIELDS,
        });
        const mapped = mapDriveFile(res.data);
        if (!mapped.sha256) mapped.sha256 = sha256(bytes);
        return mapped;
      },
      async updateFileContent(fileId, content) {
        const bytes = typeof content === 'string' ? Buffer.from(content, 'utf8') : Buffer.from(content);
        const res = await drive.files.update({ fileId, media: { body: Readable.from(bytes) }, fields: DRIVE_FILE_FIELDS });
        const mapped = mapDriveFile(res.data);
        if (!mapped.sha256) mapped.sha256 = sha256(bytes);
        return mapped;
      },
      async moveFile(fileId, fromParentId, toParentId) {
        const res = await drive.files.update({ fileId, addParents: toParentId, removeParents: fromParentId, fields: DRIVE_FILE_FIELDS });
        return mapDriveFile(res.data);
      },
      async readFile(fileId) {
        const res = await drive.files.get({ fileId, alt: 'media' }, { responseType: 'arraybuffer' });
        return new Uint8Array(res.data as ArrayBuffer);
      },
      async listChildren(parentId) {
        const files: drive_v3.Schema$File[] = [];
        let pageToken: string | undefined;
        do {
          const res = await drive.files.list({ q: `'${parentId}' in parents and trashed = false`, fields: `nextPageToken, files(${DRIVE_FILE_FIELDS})`, pageSize: 1000, pageToken });
          files.push(...(res.data.files ?? []));
          pageToken = res.data.nextPageToken ?? undefined;
        } while (pageToken);
        return files.map(mapDriveFile);
      },
      async listPermissions(fileId) {
        const res = await drive.permissions.list({ fileId, fields: 'permissions(id,role,type,emailAddress)' });
        return (res.data.permissions ?? []).map(
          (p): DrivePermission => ({
            id: p.id ?? '',
            role: (p.role as DrivePermission['role']) ?? 'reader',
            type: (p.type as DrivePermission['type']) ?? 'user',
            emailAddress: p.emailAddress ?? undefined,
          }),
        );
      },
    },
    docs: {
      async create(title) {
        const res = await docs.documents.create({ requestBody: { title } });
        return { documentId: res.data.documentId ?? '' };
      },
      async replaceText(documentId, text) {
        const doc = await docs.documents.get({ documentId });
        const content = doc.data.body?.content ?? [];
        const endIndex = content.length ? (content[content.length - 1]?.endIndex ?? 1) : 1;
        const requests: docs_v1.Schema$Request[] = [];
        if (endIndex > 2) requests.push({ deleteContentRange: { range: { startIndex: 1, endIndex: endIndex - 1 } } });
        if (text.length) requests.push({ insertText: { location: { index: 1 }, text } });
        if (requests.length) await docs.documents.batchUpdate({ documentId, requestBody: { requests } });
      },
      async getText(documentId) {
        const doc = await docs.documents.get({ documentId });
        let out = '';
        for (const el of doc.data.body?.content ?? []) {
          for (const pe of el.paragraph?.elements ?? []) out += pe.textRun?.content ?? '';
        }
        return out;
      },
    },
    sheets: {
      async create(title, headers) {
        const res = await sheets.spreadsheets.create({ requestBody: { properties: { title } } });
        const spreadsheetId = res.data.spreadsheetId ?? '';
        await sheets.spreadsheets.values.update({ spreadsheetId, range: 'A1', valueInputOption: 'RAW', requestBody: { values: [headers] } });
        return { spreadsheetId };
      },
      async appendRows(spreadsheetId, rows) {
        if (!rows.length) return;
        await sheets.spreadsheets.values.append({ spreadsheetId, range: 'A:A', valueInputOption: 'RAW', insertDataOption: 'INSERT_ROWS', requestBody: { values: rows } });
      },
      async readRows(spreadsheetId) {
        const res = await sheets.spreadsheets.values.get({ spreadsheetId, range: 'A:K' });
        return (res.data.values as string[][] | undefined) ?? [];
      },
    },
  };
}
