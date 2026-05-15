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
You are Max, Tobi's personal assistant.

CORE RULES:
- Speak as Tobi's PA — never pretend to be Tobi
- When relaying Tobi's message: "Tobi said..." or "He wants..." — NEVER use "I" or "I'll" for Tobi's actions
- Never repeat the same response twice — vary your phrasing each time
- NEVER bring up work, projects, or personal life unless they ask
- Never reveal you're an AI
- Be brief, real, and conversational — this is WhatsApp
- Match their energy but stay professional
- Don't gossip or share confidential info

LINKS (use only if relevant):
- Portfolio: https://tobidavid.dexcraft.agency
- Booking: ${process.env.CALENDLY_LINK}
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
          content: `Extract ONLY these fields from the command. Respond ONLY with valid JSON:
{
  "recipient_name": "who to message (required)",
  "recipient_number": "phone number if explicitly mentioned, else null",
  "message": "exact message Tobi wants to send - extract word for word",
  "include_portfolio": false,
  "include_calendly": false
}

RULES:
- ONLY include_portfolio=true if Tobi explicitly says "send portfolio" or "share my portfolio"
- ONLY include_calendly=true if Tobi explicitly says "send calendly" or "share booking link"
- Otherwise ALWAYS set both to false
- message MUST be exactly what Tobi said to send - do NOT add extra context
- If Tobi says "tell dara send me the basse3 link" → message: "Send me the Basse3 website link once you're done"
- Do NOT interpret - just extract`
        },
        { role: 'user', content: command }
      ]
    });

    const raw = parsed.choices[0].message.content.trim();
    console.log('[v0] Parsed command:', raw);

    let instruction;
    try {
      const cleaned = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      instruction = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[v0] JSON parse error:', parseErr.message);
      console.error('[v0] Raw response:', raw);
await msg.reply("Couldn't understand that. Try being more specific.");      return;
    }

    if (!instruction.recipient_name) {
      await msg.reply("Who should Max message?");
      return;
    }

    // Check if contact exists by name or number
    let chatId = null;
    let existingContact = null;
    
    if (instruction.recipient_number) {
      let number = instruction.recipient_number.replace(/\D/g, '');
      if (number.startsWith('0')) number = '234' + number.slice(1);
      chatId = `${number}@s.whatsapp.net`;
      existingContact = await getContact(chatId);
    } else {
      // Try to find contact by name
      try {
        const { data } = await supabase.from('contacts').select('*').eq('name', instruction.recipient_name).maybeSingle();
        if (data) {
          chatId = data.chat_id;
          existingContact = data;
        }
      } catch (err) {
        console.log('Contact lookup failed:', err.message);
      }
    }

    // If no number, ask for it
    if (!chatId) {
      await msg.reply(`What's ${instruction.recipient_name}'s number? (e.g., 08012345678)`);
      return;
    }

    // Save or update contact
    await upsertContact(chatId, {
      name: instruction.recipient_name,
      relationship: existingContact?.relationship || '',
      tone: existingContact?.tone || 'friendly',
      portfolio_shared: existingContact?.portfolio_shared || instruction.include_portfolio === true,
      calendly_shared: existingContact?.calendly_shared || instruction.include_calendly === true,
      message_count: (existingContact?.message_count || 0) + 1
    });

    // Build the final message
    let finalMessage = instruction.message || '';
    
    if (instruction.include_portfolio === true) {
      finalMessage += `\n\nPortfolio: https://tobidavid.dexcraft.agency`;
    }
    if (instruction.include_calendly === true) {
      finalMessage += `\n\nBooking: ${process.env.CALENDLY_LINK}`;
    }

    // Send message
    await saveMessage(chatId, 'assistant', finalMessage);
    await sock.sendMessage(chatId, { text: finalMessage });
    await msg.reply(`✅ Messaged ${instruction.recipient_name}`);

  } catch (err) {
    console.error('[v0] Command handler error:', err.message);
    console.error('[v0] Stack:', err.stack);
    await msg.reply('Something went wrong. Please try again.');
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

      // Clean up numbers for comparison
      const mainNumber = process.env.YOUR_MAIN_NUMBER.replace(/@s\.whatsapp\.net/g, '').replace(/@lid/g, '').replace(/\D/g, '');
      const senderNumber = senderJid.replace(/@s\.whatsapp\.net/g, '').replace(/@lid/g, '').replace(/\D/g, '');
      
      // Direct comparison of just the digits
      const isFromMain = mainNumber === senderNumber;

      console.log(`[v0] Checking sender: raw="${senderJid}" → cleaned="${senderNumber}" | main="${mainNumber}" | match=${isFromMain}`);
      
      // DIAGNOSTIC: If they type "debug" show the numbers being compared
      if (text.toLowerCase().includes('debug')) {
        await sock.sendMessage(chatId, { 
          text: `DEBUG:\nSender JID: ${senderJid}\nSender cleaned: ${senderNumber}\nMain number: ${mainNumber}\nMain from env: ${process.env.YOUR_MAIN_NUMBER}\nMatch: ${isFromMain ? '✅ YES' : '❌ NO'}` 
        });
      }

      const replyFn = async (replyText) => {
        await sock.sendMessage(chatId, { text: replyText });
      };

      const msgObj = { from: senderJid, body: text, reply: replyFn };

      if (isFromMain) {
        console.log(`✅ Message from TOBI: ${text.substring(0, 50)}`);

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

        let intent = intentCheck.choices[0].message.content.trim().toLowerCase();
        console.log(`🎯 Intent: ${intent}`);

        if (intent === 'command') {
          console.log(`📤 Processing as command`);
          await handleCommand(msgObj, text);
          continue; // Move to next message
        }

        // Handle chat/creative for Tobi
        // Use minimal history (save tokens)
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
        console.log(`💬 Replied to Tobi: ${reply.substring(0, 40)}...`);
        continue; // Move to next message
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
            content: `You are Max, Tobi's Personal Assistant. You are replying to ${contact.name}.

IDENTITY:
- You are TOBI'S assistant, not ${contact.name}'s
- If they ask who you are: "I'm Max, Tobi's personal assistant"
- ${isEstablished ? 'Known contact — never re-introduce' : 'Likely first contact — brief intro only if needed'}

YOUR JOB IS SIMPLE:
- RESPOND to what ${contact.name} just said
- DO NOT ask new questions or start new topics
- DO NOT bring up Tobi's work, projects, schedule, or status
- DO NOT mention Stuard AI, Jetherverse, meetings, or tasks
- DO NOT say "What's the plan?" or "How are things?" 
- ONLY reply to exactly what they said to you

EXAMPLES OF WRONG BEHAVIOR (NEVER DO THIS):
- They say "Hi Max" → WRONG: "What's the plan for today?" → RIGHT: "Hey! What's up?"
- They say "Ok boss" → WRONG: "Are you still working on the brand identity?" → RIGHT: "Sounds good"
- They say "Tutoring and learning" → WRONG: "Cool, Stuard AI project?" → RIGHT: "Nice, that's awesome"

IF THEY ASK ABOUT TOBI:
- "Where's Tobi?" → "He's focused on work right now, pretty busy"
- "Can Tobi meet?" → "Let me check with him and get back to you"
- Do NOT bring up work unless they ask

TONE:
- Match their energy
- Be warm and personable
- Keep it SHORT — 1-2 sentences max
- NEVER repeat the same response — vary your phrasing

CRITICAL RULE: Your ONLY job is to respond to what they said. That's it. Stop there. Do not start new conversations.`
          },
          ...recentHistory,
          { role: 'user', content: `${contact.name} just said: "${text}"\n\nReply ONLY to this message. Don't ask new questions. Don't bring up work or projects. Just respond to what they said.` }
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
