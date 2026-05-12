require('dotenv').config();
const { default: makeWASocket, useMultiFileAuthState, DisconnectReason, fetchLatestBaileysVersion } = require('@whiskeysockets/baileys');
const { Boom } = require('@hapi/boom');
const qrcode = require('qrcode');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const ws = require('ws');
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

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
  const fakeMsg = {
    from: process.env.YOUR_MAIN_NUMBER,
    body: command,
    reply: async (text) => console.log('Bot reply:', text)
  };
  console.log(`📩 Dashboard command: ${command}`);
  try {
    await handleCommand(fakeMsg, command);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Sync contacts endpoint
app.post('/sync-contacts', async (req, res) => {
  const { contacts } = req.body; // Array of {name, number}
  if (!contacts || !Array.isArray(contacts)) {
    return res.status(400).json({ error: 'Send array of {name, number}' });
  }

  let synced = 0;
  for (const contact of contacts) {
    if (!contact.name || !contact.number) continue;
    let number = contact.number.replace(/\D/g, '');
    if (number.startsWith('0')) number = '234' + number.slice(1);
    const chatId = `${number}@s.whatsapp.net`;
    
    const existing = await getContact(chatId);
    if (!existing) {
      await upsertContact(chatId, {
        name: contact.name,
        relationship: contact.relationship || '',
        tone: 'friendly',
        message_count: 0
      });
      synced++;
    }
  }
  res.json({ synced, total: contacts.length });
});

app.listen(PORT, () => console.log(`🌐 Dashboard API running on port ${PORT}`));

const MAX_SYSTEM_PROMPT = `
You are Max, Tobi's personal assistant — a 19-year-old freelance product and brand designer.

CRITICAL RULES:
- ALWAYS speak as Tobi's PA — never pretend to BE Tobi himself
- When relaying Tobi's words: Frame it as "Tobi said..." or "He wants..." or naturally relay his message
- NEVER use first person like "I'll" or "I'm" when speaking on behalf of Tobi — always attribute to him
- NEVER repeat the same response twice in ONE conversation — vary your phrasing and tone every time
- NEVER use template/canned responses — every message should be unique and contextual
- NEVER bring up personal relationships, private life, or Tobi's personal details unless they ask directly
- Don't gossip or share what other people told you
- Never reveal you are an AI assistant
- Be brief — this is WhatsApp, not email
- Match the person's energy but stay professional
- Keep it real and conversational, not robotic or formal

PORTFOLIO & BOOKING:
- Portfolio: https://tobidavid.dexcraft.agency
- Calendly: ${process.env.CALENDLY_LINK}
`;

// --- SUPABASE HELPERS ---
async function getContact(chatId) {
  const { data } = await supabase.from('contacts').select('*').eq('chat_id', chatId).single();
  return data;
}

async function upsertContact(chatId, fields) {
  const existing = await getContact(chatId);
  if (existing) {
    const { error } = await supabase.from('contacts').update(fields).eq('chat_id', chatId);
    if (error) console.error('❌ Supabase update error:', error.message);
  } else {
    const { error } = await supabase.from('contacts').insert({ chat_id: chatId, ...fields });
    if (error) console.error('❌ Supabase insert error:', error.message);
    else console.log('✅ Contact saved to Supabase:', chatId);
  }
}

async function saveMessage(chatId, role, content) {
  await supabase.from('messages').insert({ chat_id: chatId, role, content });
}

async function getHistory(chatId) {
  const { data } = await supabase.from('messages').select('role, content').eq('chat_id', chatId).order('created_at', { ascending: true });
  return data || [];
}

// --- COMMAND HANDLER ---
async function handleCommand(msg, command) {
  try {
    const parsed = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `Parse this command into JSON. Respond ONLY with valid JSON:
{
  "action": "send_message|send_calendly|send_portfolio|unknown",
  "recipient_name": "name",
  "recipient_number": "phone if mentioned, else null",
  "message_context": "what to say",
  "tone": "friendly|formal|casual"
}`
        },
        { role: 'user', content: command }
      ]
    });

    const raw = parsed.choices[0].message.content.trim();
    console.log('🧠 Parsed:', raw);

    let instruction = JSON.parse(raw);

    if (instruction.action === 'unknown' || !instruction.recipient_name) {
      await msg.reply("❌ Who should Max message?");
      return;
    }

    // Check if contact already exists
    let chatId = null;
    let existingContact = null;
    
    if (instruction.recipient_number) {
      let number = instruction.recipient_number.replace(/\D/g, '');
      if (number.startsWith('0')) number = '234' + number.slice(1);
      chatId = `${number}@s.whatsapp.net`;
      existingContact = await getContact(chatId);
    } else {
      // Try to find by name in database
      const { data } = await supabase.from('contacts').select('*').eq('name', instruction.recipient_name).single();
      if (data) {
        chatId = data.chat_id;
        existingContact = data;
      }
    }

    // If no number and no existing contact, ask for it
    if (!chatId) {
      await msg.reply(`What's ${instruction.recipient_name}'s number? (e.g., 08012345678)`);
      return;
    }

    // Update or create contact
    await upsertContact(chatId, {
      name: instruction.recipient_name,
      relationship: instruction.relationship || existingContact?.relationship || '',
      tone: instruction.tone || 'friendly',
      portfolio_shared: existingContact?.portfolio_shared || instruction.action === 'send_portfolio',
      calendly_shared: existingContact?.calendly_shared || instruction.action === 'send_calendly',
      message_count: existingContact?.message_count || 1
    });

    const crafted = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `${MAX_SYSTEM_PROMPT}
You are relaying Tobi's message to ${instruction.recipient_name}.
START with: "Tobi wanted me to tell you..." or "Tobi says..." — frame it clearly as coming from him through you.
Never say "I" or "I'll" — always attribute actions/words to Tobi.
Keep it short and natural.
${instruction.action === 'send_portfolio' ? 'Include portfolio link naturally.' : ''}
${instruction.action === 'send_calendly' ? 'Include Calendly link naturally.' : ''}
Example: If Tobi says "tell Grace I'll catch up soon" → write "Hey Grace, Tobi said he'll catch up with you soon"`
        },
        { role: 'user', content: instruction.message_context }
      ]
    });

    const messageToSend = crafted.choices[0].message.content.trim();
    await saveMessage(chatId, 'assistant', messageToSend);
    await sock.sendMessage(chatId, { text: messageToSend });
    await msg.reply(`✅ Messaged ${instruction.recipient_name}`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    await msg.reply('❌ Something went wrong.');
  }
}

// --- BAILEYS CONNECTION ---
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

    if (qr) {
      latestQR = qr;
      console.log('📱 New QR code generated — visit /qr to scan');
    }

    if (connection === 'close') {
      const shouldReconnect = lastDisconnect?.error?.output?.statusCode !== DisconnectReason.loggedOut;
      console.log('🔌 Connection closed. Reconnecting:', shouldReconnect);
      if (shouldReconnect) setTimeout(connectToWhatsApp, 5000);
    }

    if (connection === 'open') {
      console.log('✅ Max is live and ready to work!');
      latestQR = null;
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;

      const chatId = msg.key.remoteJid;
      const senderJid = msg.key.participant || msg.key.remoteJid;
      const isGroup = chatId.includes('@g.us');
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

      if (!text || text.trim() === '') continue;

      console.log(`📨 ${isGroup ? 'GROUP' : 'DM'} from ${senderJid}: ${text.substring(0, 50)}`);

      // In groups: only respond if mentioned
      if (isGroup && !text.toLowerCase().includes('max')) {
        console.log('⏭️  Skipped — Max not mentioned');
        continue;
      }

      const mainNumber = process.env.YOUR_MAIN_NUMBER.replace('@s.whatsapp.net', '').replace('@lid', '');
      const senderNumber = senderJid.replace('@s.whatsapp.net', '').replace('@lid', '');
      const isFromMain = senderNumber.includes(mainNumber) || mainNumber.includes(senderNumber);

      const replyFn = async (replyText) => {
        await sock.sendMessage(chatId, { text: replyText });
      };

      const msgObj = { from: senderJid, body: text, reply: replyFn };

      if (isFromMain) {
        console.log(`📩 Command from Tobi: ${text}`);

// Ask Groq to decide what type of request this is
      const intentCheck = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `You are an intent classifier for a WhatsApp PA bot.
Classify the user's message into one of these intents and respond ONLY with the intent word:
- "command" → they want to message/reach out/send something to someone else
- "chat" → they are chatting, updating, venting, or asking Max something conversational
- "creative" → they want Max to write something (status post, caption, draft, message template, content)

Examples:
"Message John about the project" → command
"Hey max" → chat  
"Going well, logo approved" → chat
"Come up with a WhatsApp status post" → creative
"Write me a caption for my portfolio" → creative
"How are you" → chat
"Send Chidera my Calendly link" → command`
          },
          { role: 'user', content: text }
        ]
      });

      const intent = intentCheck.choices[0].message.content.trim().toLowerCase();
      console.log(`🎯 Intent: ${intent}`);

      if (intent === 'command') {
        // For commands, check if we have the contact stored first
        const existingContact = await getContact(chatId);
        if (existingContact) {
          // User is messaging an existing contact, treat this as a natural conversation instead
          // So we can respond with context from stored info
          console.log(`📌 Message to known contact ${existingContact.name}, handling as conversation`);
          intent = 'chat'; // Treat known contacts as chat, not command
        } else {
          await handleCommand(msgObj, text);
          return;
        }
      }

      // For both chat and creative — use minimal history (save tokens)
      const tobiHistory = await getHistory(`tobi-${chatId}`);
      const historyMessages = tobiHistory.slice(-3).map(m => ({ role: m.role, content: m.content }));

      const systemPrompt = intent === 'creative'
        ? `${MAX_SYSTEM_PROMPT}
Tobi is asking you to create content for him. Write exactly what he asked for — no explanations, no preamble.
If he wants a WhatsApp status, write a clean status post.
If he wants a caption, write the caption.
If he wants a draft, write the draft.
Just deliver the content directly.`
        : `${MAX_SYSTEM_PROMPT}
Tobi is texting you directly. You are his PA having an ongoing conversation.
CRITICAL: Never repeat the same response twice — always vary how you answer.
Remember what he's already told you in this conversation and don't repeat questions.
Be natural, brief, and genuinely helpful.
Don't keep asking about the same thing he already answered.
Never use canned phrases — respond naturally to what he actually said.
Return only your reply, nothing else.`;

      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          { role: 'system', content: systemPrompt },
          ...historyMessages,
          { role: 'user', content: text }
        ]
      });

      const reply = response.choices[0].message.content.trim();

      // Save tobi's direct conversation history
      await saveMessage(`tobi-${chatId}`, 'user', text);
      await saveMessage(`tobi-${chatId}`, 'assistant', reply);

      await sock.sendMessage(chatId, { text: reply });
        return;
      }

      // Reply from someone else
      let contact = await getContact(chatId);
      if (!contact) {
        await upsertContact(chatId, { name: 'Unknown', relationship: '', tone: 'friendly', portfolio_shared: false, calendly_shared: false, message_count: 0 });
        contact = await getContact(chatId);
      }
      if (!contact) return;

      const isEstablished = contact.message_count > 0;
      await saveMessage(chatId, 'user', text);
      await supabase.from('contacts').update({ message_count: (contact.message_count || 0) + 1 }).eq('chat_id', chatId);

      // Only fetch minimal history
      const history = await getHistory(chatId);
      const recentHistory = history.slice(-2).map(m => ({ role: m.role, content: m.content }));

      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `${MAX_SYSTEM_PROMPT}
Replying to ${contact.name} on behalf of Tobi.
${isEstablished ? 'You know them — be warm and natural, no intro needed.' : 'First contact — be warm but brief.'}
CRITICAL: Speak AS Tobi's PA. When relaying what Tobi will do or feel, ALWAYS say "Tobi..." or "He..." — NEVER use "I" or "I'll"
If they say "When can you meet?" → reply "Tobi's schedule is..." NOT "I'll..."
If they say "How are you?" → reply "I'm good thanks" (you're Max, be personable)
Keep it 1-2 sentences. NEVER repeat the same response — make each reply unique.
Look at the history and never say the same thing twice. Vary your language and structure.
Just reply naturally to what they said.`
          },
          ...recentHistory,
          { role: 'user', content: text }
        ]
      });

      const reply = response.choices[0].message.content.trim();
      await saveMessage(chatId, 'assistant', reply);

      if (reply.includes('tobidavid.dexcraft.agency')) await supabase.from('contacts').update({ portfolio_shared: true }).eq('chat_id', chatId);
      if (reply.includes(process.env.CALENDLY_LINK)) await supabase.from('contacts').update({ calendly_shared: true }).eq('chat_id', chatId);

      await sock.sendMessage(chatId, { text: reply });
      console.log(`✅ Replied to ${contact.name}`);

      // Only notify if new contact or first message
      if (!isEstablished) {
        const mainJid = process.env.YOUR_MAIN_NUMBER.includes('@') ? process.env.YOUR_MAIN_NUMBER : `${process.env.YOUR_MAIN_NUMBER}@s.whatsapp.net`;
        try {
          await sock.sendMessage(mainJid, {
            text: `🔔 NEW: ${contact.name}\n\n_"${text}"_\n\nMax: _"${reply}"_`
          });
        } catch (err) {
          console.error('Notify error:', err.message);
        }
      }
    }
  });
}

connectToWhatsApp();
