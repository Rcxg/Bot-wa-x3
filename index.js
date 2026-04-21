'use strict';

const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason,
  makeInMemoryStore,
  jidNormalizedUser,
} = require('@whiskeysockets/baileys');
const pino = require('pino');
const fs = require('fs');
const path = require('path');
const { Boom } = require('@hapi/boom');

/**
 * ============ KONFIGURASI ============
 * Ganti sesuai kebutuhan sekolah Anda.
 */
const CONFIG = {
  sessionFolder: 'auth',
  dataFile: 'data.json',
  jadwalFile: 'jadwal.pdf',
  prefix: '!',

  // Isi dengan JID grup kelas, contoh: '1203630xxxxx@g.us'
  classGroupJid: '120363000000000000@g.us',

  // Isi nomor admin (tanpa +, hanya angka), contoh: '6281234567890'
  adminNumbers: ['6281234567890'],

  // Isi nomor guru tujuan auto-forward (tanpa +, hanya angka)
  teacherNumber: '6281111111111',
};

const logger = pino({ level: 'info' });
const store = makeInMemoryStore({ logger: pino({ level: 'silent' }) });

const DATA_PATH = path.join(process.cwd(), CONFIG.dataFile);
const JADWAL_PATH = path.join(process.cwd(), CONFIG.jadwalFile);

function ensureDataFile() {
  if (!fs.existsSync(DATA_PATH)) {
    const initialData = { tugas: [] };
    fs.writeFileSync(DATA_PATH, JSON.stringify(initialData, null, 2));
    logger.info(`Membuat file data awal: ${CONFIG.dataFile}`);
  }
}

function readTaskData() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(DATA_PATH, 'utf8');
    const json = JSON.parse(raw);
    if (!json.tugas || !Array.isArray(json.tugas)) {
      return { tugas: [] };
    }
    return json;
  } catch (err) {
    logger.error({ err }, 'Gagal membaca data.json, fallback ke data kosong');
    return { tugas: [] };
  }
}

function writeTaskData(data) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

function getSenderNumber(message) {
  const participant = message.key.participant || message.key.remoteJid || '';
  return participant.split('@')[0];
}

function isAdmin(senderNumber) {
  return CONFIG.adminNumbers.includes(senderNumber);
}

function parseMessageText(msg) {
  return (
    msg?.message?.conversation ||
    msg?.message?.extendedTextMessage?.text ||
    msg?.message?.imageMessage?.caption ||
    msg?.message?.videoMessage?.caption ||
    ''
  ).trim();
}

function formatMenu() {
  return [
    '📚 *BOT KETUA KELAS*',
    '',
    '*Daftar Command:*',
    `${CONFIG.prefix}menu`,
    `${CONFIG.prefix}tugas`,
    `${CONFIG.prefix}addtugas mapel|tugas|deadline _(admin)_`,
    `${CONFIG.prefix}jadwal`,
    `${CONFIG.prefix}pengumuman pesan _(admin)_`,
    '',
    '*Contoh:*',
    `${CONFIG.prefix}addtugas Matematika|Hal. 21 No 1-10|2026-04-30`,
  ].join('\n');
}

function formatTaskList(tasks) {
  if (!tasks.length) {
    return '📭 Belum ada tugas yang tersimpan.';
  }

  const lines = ['📝 *Daftar Tugas:*', ''];
  tasks.forEach((item, idx) => {
    lines.push(
      `${idx + 1}. *Mapel:* ${item.mapel}\n   *Tugas:* ${item.tugas}\n   *Deadline:* ${item.deadline}`
    );
  });

  return lines.join('\n');
}

async function sendJadwal(sock, jid) {
  if (!fs.existsSync(JADWAL_PATH)) {
    await sock.sendMessage(jid, {
      text: `⚠️ File ${CONFIG.jadwalFile} tidak ditemukan di root folder server.`,
    });
    return;
  }

  const fileBuffer = fs.readFileSync(JADWAL_PATH);
  await sock.sendMessage(jid, {
    document: fileBuffer,
    fileName: CONFIG.jadwalFile,
    mimetype: 'application/pdf',
    caption: '📌 Berikut jadwal pelajaran terbaru.',
  });
}

async function sendAnnouncement(sock, groupJid, text) {
  const metadata = await sock.groupMetadata(groupJid);
  const mentions = metadata.participants.map((p) => p.id);
  const mentionText = mentions.map((id) => `@${id.split('@')[0]}`).join(' ');

  await sock.sendMessage(groupJid, {
    text: `📢 *PENGUMUMAN*\n\n${text}\n\n${mentionText}`,
    mentions,
  });
}

async function handleIncomingMessage(sock, upsert) {
  const msg = upsert.messages?.[0];
  if (!msg || msg.key.fromMe) return;

  const remoteJid = msg.key.remoteJid;
  const senderNumber = getSenderNumber(msg);
  const text = parseMessageText(msg);
  if (!text) return;

  // Auto-forward izin/sakit dari grup kelas ke guru
  const lower = text.toLowerCase();
  const isClassGroup = remoteJid === CONFIG.classGroupJid;
  const shouldForward =
    isClassGroup &&
    text.length > 15 &&
    (lower.includes('izin') || lower.includes('sakit'));

  if (shouldForward) {
    const teacherJid = jidNormalizedUser(`${CONFIG.teacherNumber}@s.whatsapp.net`);
    const originalSender = `@${senderNumber}`;

    await sock.sendMessage(teacherJid, {
      text: [
        '📨 *AUTO-FORWARD LAPORAN SISWA*',
        `Dari: ${originalSender}`,
        `Grup: ${remoteJid}`,
        '',
        text,
      ].join('\n'),
      mentions: [`${senderNumber}@s.whatsapp.net`],
    });
  }

  if (!text.startsWith(CONFIG.prefix)) return;

  const [command, ...restArgs] = text.slice(CONFIG.prefix.length).trim().split(' ');
  const argsText = restArgs.join(' ').trim();

  switch ((command || '').toLowerCase()) {
    case 'menu': {
      await sock.sendMessage(remoteJid, { text: formatMenu() }, { quoted: msg });
      break;
    }

    case 'tugas': {
      const data = readTaskData();
      await sock.sendMessage(remoteJid, { text: formatTaskList(data.tugas) }, { quoted: msg });
      break;
    }

    case 'addtugas': {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(remoteJid, { text: '❌ Hanya admin yang bisa menambah tugas.' }, { quoted: msg });
        break;
      }

      const parts = argsText.split('|').map((s) => s.trim());
      if (parts.length !== 3 || parts.some((x) => !x)) {
        await sock.sendMessage(
          remoteJid,
          { text: `Format salah. Gunakan: ${CONFIG.prefix}addtugas mapel|tugas|deadline` },
          { quoted: msg }
        );
        break;
      }

      const [mapel, tugas, deadline] = parts;
      const data = readTaskData();
      data.tugas.push({ mapel, tugas, deadline, createdAt: new Date().toISOString() });
      writeTaskData(data);

      await sock.sendMessage(remoteJid, { text: '✅ Tugas berhasil ditambahkan.' }, { quoted: msg });
      break;
    }

    case 'jadwal': {
      await sendJadwal(sock, remoteJid);
      break;
    }

    case 'pengumuman': {
      if (!isAdmin(senderNumber)) {
        await sock.sendMessage(remoteJid, { text: '❌ Hanya admin yang bisa kirim pengumuman.' }, { quoted: msg });
        break;
      }

      if (!remoteJid.endsWith('@g.us')) {
        await sock.sendMessage(remoteJid, { text: '⚠️ Command ini hanya bisa digunakan di grup.' }, { quoted: msg });
        break;
      }

      if (!argsText) {
        await sock.sendMessage(
          remoteJid,
          { text: `Format salah. Gunakan: ${CONFIG.prefix}pengumuman isi pesan` },
          { quoted: msg }
        );
        break;
      }

      await sendAnnouncement(sock, remoteJid, argsText);
      break;
    }

    default:
      await sock.sendMessage(remoteJid, { text: `Command tidak dikenal. Ketik ${CONFIG.prefix}menu` }, { quoted: msg });
  }
}

async function startBot() {
  ensureDataFile();

  const { state, saveCreds } = await useMultiFileAuthState(CONFIG.sessionFolder);
  const { version, isLatest } = await fetchLatestBaileysVersion();
  logger.info(`Memakai WA Web version: ${version.join('.')} | isLatest=${isLatest}`);

  const sock = makeWASocket({
    logger,
    auth: state,
    browser: ['Ketua Kelas Bot', 'Chrome', '1.0.0'],
    version,
    printQRInTerminal: true,
    syncFullHistory: false,
    markOnlineOnConnect: false,
  });

  store.bind(sock.ev);

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect } = update;

    if (connection === 'close') {
      const error = lastDisconnect?.error ? new Boom(lastDisconnect.error).output.statusCode : undefined;
      const shouldReconnect = error !== DisconnectReason.loggedOut;

      logger.warn(
        {
          reasonCode: error,
          shouldReconnect,
        },
        'Koneksi terputus'
      );

      if (shouldReconnect) {
        logger.info('Mencoba reconnect dalam 3 detik...');
        setTimeout(() => {
          startBot().catch((err) => logger.error({ err }, 'Gagal restart bot'));
        }, 3000);
      } else {
        logger.error('Session logout. Hapus folder auth jika ingin login ulang dari awal.');
      }
    }

    if (connection === 'open') {
      logger.info('✅ Bot WhatsApp terhubung!');
    }
  });

  sock.ev.on('messages.upsert', async (upsert) => {
    try {
      if (upsert.type !== 'notify') return;
      await handleIncomingMessage(sock, upsert);
    } catch (err) {
      logger.error({ err }, 'Terjadi error saat memproses pesan');
    }
  });
}

startBot().catch((err) => {
  logger.error({ err }, 'Fatal error saat menjalankan bot');
  process.exit(1);
});
