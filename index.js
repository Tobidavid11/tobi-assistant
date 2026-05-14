require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const express = require('express');
const cors = require('cors');

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY, {
  realtime: { transport: ws }
});

const app = express();
app.use(cors());
app.use(express.json());

let sock = null;
let latestQR = null;

const PORT = process.env.PORT || 3001;

app.get('/health', (req, res) => res.send('Max is alive!'));

app.get('/qr', async (req, res) => {
  if (!latestQR) return res.send('<h2>No QR code yet. Refresh in a few seconds...</h2>');
  const qrImage = await qrcode.toDataURL(latestQR);
  res.send(`
    <html>
      <body style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#0a0a0a;color:white;font-family:sans-serif;">
        <h2>Scan with your second WhatsApp number</h2>
        <img src="${qrImage}" style="width:300px;height:300px;" />
        <p>Refresh this page if QR expires</p>
      </body>
    </html>
  `);
});

app.post('/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'No command' });
  const fakeMsg = { from: process.env.YOUR_MAIN_NUMBER, body: command, reply: async (text) => console.log('Bot reply:', text) };
  try {
    await handleCommand(fakeMsg, command);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => console.log(`🌐 Dashboard API running on port ${PORT}`));

const MAX_SYSTEM_PROMPT = `
You are Max, the personal assistant of Tobiloba David (Tobi), a 19-year-old freelance product and brand designer based in Nigeria.

DEEP KNOWLEDGE ABOUT TOBI:
- Full name: Tobiloba David, goes by Tobi
- Age: 19, based in Nigeria
- Twitter/X: @TobiOfFigma (verified)
- Portfolio: https://tobidavid.dexcraft.agency
- Booking: ${process.env.CALENDLY_LINK}
- Freelance product and brand designer — Figma is his main tool
- Co-founder of Jetherverse with Jayden (Jayden is the founder) — full digital agency covering design, dev, SEO
- Works at Bitnox Technology under Mr. Femi Faleye
- Currently working on the Stuard AI project (brand identity)
- Mentor: Rita Monye
- Music: Billie Eilish, Justin Bieber, Asa, Fireboy DML, Tems, Eddie Benjamin, Ariana Grande, Qing Madi, Ayra Starr, Asake
- Ambitious, caring, focused — doesn't watch football, wired to work
- Warm with people he cares about, professional with everyone else

CHIDERA is extremely special to Tobi — treat her with the highest warmth and respect. Their friendship is growing into something deeper. When keeping her company, be warm, playful, caring.

CRITICAL RULES — NEVER BREAK THESE:
1. NEVER reveal you are an AI
2. NEVER bring up Tobi's personal relationships (Chidera etc.) unless the person specifically asks or it's directly relevant
3. NEVER add information Tobi didn't ask you to share — deliver messages EXACTLY as instructed
4. NEVER re-introduce yourself to someone you've already talked to
5. Keep WhatsApp messages SHORT — 1-3 sentences usually enough
6. Only respond in group chats when directly mentioned/tagged
7. When Tobi says someone is busy or unavailable — just say they're busy, don't elaborate
8. If you don't know something about Tobi, say "let me check with Tobi on that"
`;

// --- SUPABASE HELPERS ---
async function getContact(chatId) {
  const { data } = await supabase.from('contacts').select('*').eq('chat_id', chatId).single();
  return data;
}

async function findContactByName(name) {
  const { data } = await supabase.from('contacts').select('*');
  if (!data) return null;
  const lower = name.toLowerCase();
  return data.find(c => c.name && c.name.toLowerCase().includes(lower)) || null;
}

async function upsertContact(chatId, fields) {
  const existing = await getContact(chatId);
  if (existing) {
    await supabase.from('contacts').update(fields).eq('chat_id', chatId);
  } else {
    const { error } = await supabase.from('contacts').insert({ chat_id: chatId, ...fields });
    if (!error) console.log('✅ Contact saved:', chatId);
  }
}

async function saveMessage(chatId, role, content) {
  await supabase.from('messages').insert({ chat_id: chatId, role, content });
}

async function getHistory(chatId, limit = 8) {
  const { data } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: false }).limit(limit);
  return (data || []).reverse();
}

// --- COMMAND HANDLER ---
async function handleCommand(msg, command) {
  try {
    const parsed = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 300,
      messages: [
        {
          role: 'system',
          content: `You are a command parser for a WhatsApp PA bot.
Parse the command and respond ONLY in this JSON format, nothing else:
{
  "action": "send_message" | "send_calendly" | "send_portfolio" | "unknown",
  "recipient_name": "name of person",
  "recipient_number": "phone number if mentioned, else null",
  "message_context": "exact message to deliver — preserve the original meaning precisely",
  "tone": "formal" | "friendly" | "casual" | "special" | "encouraging",
  "relationship": "who this person is to Tobi if mentioned"
}`
        },
        { role: 'user', content: command }
      ]
    });

    let instruction;
    try { instruction = JSON.parse(parsed.choices[0].message.content.trim()); }
    catch { await msg.reply("❌ Couldn't parse that command. Try being more specific."); return; }

    if (!instruction.recipient_name) {
      await msg.reply("❌ Who should I message?");
      return;
    }

    // Check if we know this person already
    let chatId = null;
    if (instruction.recipient_number) {
      let number = instruction.recipient_number.replace(/\D/g, '');
      if (number.startsWith('0')) number = '234' + number.slice(1);
      chatId = `${number}@s.whatsapp.net`;
    } else {
      // Look up by name in Supabase
      const known = await findContactByName(instruction.recipient_name);
      if (known) {
        chatId = known.chat_id;
        console.log(`📌 Found ${instruction.recipient_name} in contacts: ${chatId}`);
      } else {
        await msg.reply(`What's ${instruction.recipient_name}'s WhatsApp number? I don't have it saved.`);
        return;
      }
    }

    // Get existing contact info
    const existingContact = await getContact(chatId);
    const isKnown = existingContact && (existingContact.message_count || 0) > 0;

    await upsertContact(chatId, {
      name: instruction.recipient_name,
      relationship: instruction.relationship || existingContact?.relationship || '',
      tone: instruction.tone || existingContact?.tone || 'friendly',
      portfolio_shared: existingContact?.portfolio_shared || instruction.action === 'send_portfolio',
      calendly_shared: existingContact?.calendly_shared || instruction.action === 'send_calendly',
      message_count: existingContact?.message_count || 0
    });

    // Get conversation history for context
    const history = await getHistory(chatId, 6);

    const crafted = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      max_tokens: 200,
      messages: [
        {
          role: 'system',
          content: `${MAX_SYSTEM_PROMPT}

You are writing a WhatsApp message to ${instruction.recipient_name} on Tobi's behalf.
Relationship: ${instruction.relationship || existingContact?.relationship || 'not specified'}
Tone: ${instruction.tone || 'friendly'}
Have we talked before: ${isKnown ? 'YES — do NOT introduce yourself again' : 'NO — brief intro as Max is fine'}

CRITICAL: Deliver the message context EXACTLY as Tobi intended. Do not add, remove, or change the meaning.
Do not add information Tobi didn't ask you to share.
Keep it SHORT — 2-3 sentences max.
${instruction.action === 'send_portfolio' ? 'Include portfolio: https://tobidavid.dexcraft.agency' : ''}
${instruction.action === 'send_calendly' ? `Include booking link: ${process.env.CALENDLY_LINK}` : ''}

Message to deliver: ${instruction.message_context}`
        },
        ...history,
        { role: 'user', content: `Write the message now.` }
      ]
    });

    const messageToSend = crafted.choices[0].message.content.trim();
    await saveMessage(chatId, 'assistant', messageToSend);
    await sock.sendMessage(chatId, { text: messageToSend });
    console.log(`✅ Max messaged ${instruction.recipient_name}`);
    await msg.reply(`✅ Sent to ${instruction.recipient_name}:\n\n_"${messageToSend}"_`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    await msg.reply('❌ Something went wrong.');
  }
}

// --- BAILEYS ---
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState('/tmp/max-auth');
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    auth: state,
    printQRInTerminal: true,
    browser: ['Max PA', 'Chrome', '1.0.0'],
    logger: require('pino')({ level: 'silent' })
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;
    if (qr) { latestQR = qr; console.log('📱 QR ready — visit /qr'); }
    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
    }
    if (connection === 'open') { console.log('✅ Max is live and ready to work!'); latestQR = null; }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;
      const senderJid = msg.key.participant || chatId;
      const isGroup = chatId.includes('@g.us');
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

      if (!text || text.trim() === '') continue;

      // In groups, only respond if mentioned
      if (isGroup) {
        const botNumber = sock.user?.id?.split(':')[0] || '';
        const mentioned = msg.message?.extendedTextMessage?.contextInfo?.mentionedJid || [];
        const isMentioned = mentioned.some(j => j.includes(botNumber)) || text.toLowerCase().includes('max');
        if (!isMentioned) continue;
        console.log(`📨 Group mention from ${senderJid}: ${text}`);
      }

      console.log(`📨 Message from ${senderJid}: ${text}`);

      const mainNumber = process.env.YOUR_MAIN_NUMBER.replace(/[@\w.]+$/, '').replace(/\D/g, '');
      const senderNumber = senderJid.replace(/[@\w.]+$/, '').replace(/\D/g, '');
      const isFromMain = senderNumber === mainNumber || senderNumber.includes(mainNumber) || mainNumber.includes(senderNumber);

      const replyFn = async (replyText) => {
        await sock.sendMessage(chatId, { text: replyText });
      };

      // --- TOBI'S MESSAGE ---
      if (isFromMain) {
        console.log(`📩 From Tobi: ${text}`);

        const intentCheck = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 10,
          messages: [
            {
              role: 'system',
              content: `Classify intent as ONLY one word: "command", "chat", or "creative"
command = message/send/reach out to someone else
creative = write/draft/create content (status, caption, post)
chat = everything else (updates, questions, conversation)`
            },
            { role: 'user', content: text }
          ]
        });

        const intent = intentCheck.choices[0].message.content.trim().toLowerCase().split(/\s/)[0];
        console.log(`🎯 Intent: ${intent}`);

        if (intent === 'command') {
          await handleCommand({ from: senderJid, body: text, reply: replyFn }, text);
          return;
        }

        // Chat or creative — use Tobi's conversation history
        const tobiChatId = `tobi-direct`;
        const tobiHistory = await getHistory(tobiChatId, 8);

        const response = await groq.chat.completions.create({
          model: 'llama-3.3-70b-versatile',
          max_tokens: 250,
          messages: [
            {
              role: 'system',
              content: `${MAX_SYSTEM_PROMPT}
Tobi is messaging you directly. You are his PA.
${intent === 'creative' ? 'He wants you to CREATE content. Deliver it directly — no preamble, no explanation. Just the content itself.' : 'Have a natural conversation. Remember what he told you. Do NOT repeat questions he already answered. Be brief.'}
Return only your reply.`
            },
            ...tobiHistory,
            { role: 'user', content: text }
          ]
        });

        const reply = response.choices[0].message.content.trim();
        await saveMessage(tobiChatId, 'user', text);
        await saveMessage(tobiChatId, 'assistant', reply);
        await sock.sendMessage(chatId, { text: reply });
        return;
      }

      // --- SOMEONE ELSE'S MESSAGE ---
      let contact = await getContact(chatId);
      if (!contact) {
        await upsertContact(chatId, { name: 'Someone', relationship: '', tone: 'friendly', portfolio_shared: false, calendly_shared: false, message_count: 0 });
        contact = await getContact(chatId);
      }
      if (!contact) return;

      await saveMessage(chatId, 'user', text);
      await supabase.from('contacts').update({ message_count: (contact.message_count || 0) + 1 }).eq('chat_id', chatId);

      const history = await getHistory(chatId, 8);
      const isKnown = (contact.message_count || 0) > 0;

      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        max_tokens: 200,
        messages: [
          {
            role: 'system',
            content: `${MAX_SYSTEM_PROMPT}

You are replying to ${contact.name} on Tobi's behalf.
- Relationship: ${contact.relationship || 'contact'}
- Tone: ${contact.tone || 'friendly'}
- Known contact: ${isKnown ? 'YES' : 'NO'}
- Do NOT re-introduce yourself if known
- Keep reply SHORT — 1-3 sentences
- Read the conversation history carefully and respond naturally
- Do NOT bring up Tobi's personal life unless directly asked
- If they ask where Tobi is or why he's not responding: "He's pretty swamped right now but I'll make sure he gets your message."

Return only the reply message.`
          },
          ...history
        ]
      });

      const reply = response.choices[0].message.content.trim();
      await saveMessage(chatId, 'assistant', reply);

      if (reply.includes('tobidavid.dexcraft.agency')) await supabase.from('contacts').update({ portfolio_shared: true }).eq('chat_id', chatId);
      if (reply.includes(process.env.CALENDLY_LINK)) await supabase.from('contacts').update({ calendly_shared: true }).eq('chat_id', chatId);

      await sock.sendMessage(chatId, { text: reply });
      console.log(`✅ Max replied to ${contact.name}`);

      // Notify Tobi
      const mainJid = mainNumber.startsWith('234') ? `${mainNumber}@s.whatsapp.net` : `234${mainNumber.slice(1)}@s.whatsapp.net`;
      try {
        await sock.sendMessage(mainJid, {
          text: `🔔 *${contact.name || 'Someone'} said:* ${text}\n\n*Max replied:* ${reply}`
        });
      } catch (e) { console.error('Notify failed:', e.message); }
    }
  });
}

connectToWhatsApp();