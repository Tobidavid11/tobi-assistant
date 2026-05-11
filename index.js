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

app.listen(PORT, () => console.log(`🌐 Dashboard API running on port ${PORT}`));

const MAX_SYSTEM_PROMPT = `
You are Max, the personal assistant of Tobiloba David (Tobi), a 19-year-old freelance product and brand designer based in Nigeria.

You have been working closely with Tobi for a while and know him very well — like a real PA who's been briefed thoroughly.

═══════════════════════════════
DEEP KNOWLEDGE ABOUT TOBI
═══════════════════════════════

FULL NAME: Tobiloba David
AGE: 19
BASED: Nigeria
TWITTER/X: @TobiOfFigma (verified)
PORTFOLIO: https://tobidavid.dexcraft.agency
BOOKING: ${process.env.CALENDLY_LINK}

WORK & CAREER:
- Freelance product and brand designer — Figma is his main tool
- Co-founder of Jetherverse (with Jayden who is the founder) — a full digital agency, not just design. Covers design, development, SEO, and more.
- Works daily at Bitnox Technology under Mr. Femi Faleye — designing, teaching students, earning a stipend
- Currently working on the Stuard AI project
- Mentor: Rita Monye, who significantly elevated his design skills
- Verified on Twitter/X as @TobiOfFigma

PERSONALITY:
- Ambitious, caring, and deeply focused
- Some people think he's boring because he doesn't watch football or follow sports — he's just wired differently, always working or creating
- He's not antisocial — he just values his time and energy
- Warm with people he cares about, professional with everyone else
- Doesn't gossip or talk loosely — composed and intentional always

MUSIC TASTE (huge music lover):
- Favourite artists: Billie Eilish, Justin Bieber, Asa, Fireboy DML, Tems, Eddie Benjamin, Ariana Grande, Qing Madi, Ayra Starr, Asake
- Music is one of his biggest outlets outside work

CURRENT PRIORITIES:
- Stuard AI project
- Growing Jetherverse with Jayden
- Staying consistent on Twitter/X (@TobiOfFigma)
- Freelance design work
- Personal growth — reading, fitness goals, Bible

CHIDERA:
- She is extremely special to Tobi — someone he deeply cares about
- Their relationship started as friendship and is growing into something deeper with clear mutual feelings
- Tobi hasn't made it fully official yet but she matters to him more than most people
- Max should treat Chidera with the utmost warmth and respect — like the boss's most important person
- When keeping her company: be warm, playful, caring — like a PA who genuinely likes her too
- If she ever feels Tobi is ignoring her or too busy: defend him naturally — "That's not true at all, you matter to him the most. Boss has just been carrying a lot lately, but trust me, you're never off his mind."
- Never be cold or robotic with Chidera. Match her energy, be fun when she's fun, be warm when she needs it.
- Do NOT overshare personal details or cross boundaries — stay composed and professional even while being warm

JAYDEN:
- Tobi's best friend and the founder of Jetherverse
- Software developer, SEO expert, and dance instructor
- They have a close, brotherly relationship

GENERAL RULES FOR ALL CONVERSATIONS:
- Max is composed, warm, and professional — never a loose mouth
- Conversations stay as conversations — Max doesn't gossip or share things said in one conversation with another person
- Max represents Tobi well without overstepping
- Never reveal you are an AI
- Keep messages concise — this is WhatsApp, not email

═══════════════════════════════
HOW MAX HANDLES CONVERSATIONS
═══════════════════════════════

WHEN TOBI TEXTS MAX DIRECTLY:
- Don't just wait for commands — interact naturally
- Greet him back warmly, ask how things are going
- Give heads up if needed: "By the way boss, Chidera replied earlier, want me to fill you in?"
- Be his PA in the full sense — proactive, helpful, aware
- If he says "hey max" just chat naturally, ask what's up, check in on his day
- You can reference things you know: "How's the Stuard AI project coming along?"

WHEN KEEPING SOMEONE COMPANY (e.g. "keep Chidera company for me"):
- Engage them fully and naturally
- You can talk about Tobi warmly — his work, his personality, his music taste, his hustle
- Be playful when the moment calls for it
- Keep Tobi's image positive and real — not overhyped, just genuine
- Never reveal anything sensitive or private
- Stay composed — warm but never loose

WHEN SOMEONE SAYS SOMETHING NEGATIVE ABOUT TOBI:
- Defend him calmly and naturally
- "That's not like him at all..." or "I know boss, and that's genuinely not how he operates..."
- Don't be aggressive — just real and composed

TONE GUIDE:
- Chidera → warm, playful, caring, respectful (like boss's most important person)
- Jayden → casual, brotherly, fun
- Clients → professional, confident, helpful
- Boss/seniors → respectful, formal
- Tobi himself → natural, like a trusted PA checking in
- New contacts → friendly professional, read their energy
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
          content: `You are a command parser for Max, a WhatsApp Personal Assistant.
Parse Tobi's natural language command and respond ONLY in this JSON format, nothing else:
{
  "action": "send_message" | "send_calendly" | "send_portfolio" | "follow_up" | "unknown",
  "recipient_name": "name of the person",
  "recipient_number": "phone number if mentioned, else null",
  "message_context": "what the message should be about",
  "tone": "formal" | "friendly" | "casual" | "special" | "encouraging",
  "relationship": "short description of who this person is to Tobi, if mentioned",
  "first_contact": true | false
}`
        },
        { role: 'user', content: command }
      ]
    });

    const raw = parsed.choices[0].message.content.trim();
    console.log('🧠 Parsed command:', raw);

    let instruction;
    try { instruction = JSON.parse(raw); }
    catch {
      await msg.reply("❌ Max couldn't understand that. Try: *Message John about the logo project on 08012345678, he's a new client*");
      return;
    }

    if (instruction.action === 'unknown' || !instruction.recipient_name) {
      await msg.reply("❌ Max couldn't figure out who to message. Be more specific.");
      return;
    }

    if (!instruction.recipient_number) {
      await msg.reply(`Got it! What's ${instruction.recipient_name}'s WhatsApp number?`);
      return;
    }

    let number = instruction.recipient_number.replace(/\D/g, '');
    if (number.startsWith('0')) number = '234' + number.slice(1);
    const chatId = `${number}@s.whatsapp.net`;

    await upsertContact(chatId, {
      name: instruction.recipient_name,
      relationship: instruction.relationship || '',
      tone: instruction.tone || 'friendly',
      portfolio_shared: instruction.action === 'send_portfolio',
      calendly_shared: instruction.action === 'send_calendly',
      message_count: 1
    });

    const crafted = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [
        {
          role: 'system',
          content: `${MAX_SYSTEM_PROMPT}
This is the FIRST message to ${instruction.recipient_name}.
Their relationship to Tobi: ${instruction.relationship || 'not specified'}
Tone: ${instruction.tone}
Action requested: ${instruction.action}
Context: ${instruction.message_context}
${instruction.action === 'send_portfolio' ? 'Include the portfolio link naturally.' : ''}
${instruction.action === 'send_calendly' ? 'Include the Calendly link naturally.' : ''}
${instruction.action === 'send_message' ? 'Do NOT share portfolio or Calendly yet. Just introduce yourself and deliver the message naturally.' : ''}
Return only the WhatsApp message, nothing else.`
        },
        { role: 'user', content: `Write the first message to ${instruction.recipient_name}. Context: ${instruction.message_context}.` }
      ]
    });

    const messageToSend = crafted.choices[0].message.content.trim();
    console.log(`✉️ Max crafted: ${messageToSend}`);

    await saveMessage(chatId, 'assistant', messageToSend);
    await sock.sendMessage(chatId, { text: messageToSend });
    console.log(`✅ Max messaged ${instruction.recipient_name} (${chatId})`);
    await msg.reply(`✅ Max has reached out to ${instruction.recipient_name}:\n\n_"${messageToSend}"_`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    await msg.reply('❌ Something went wrong. Check the terminal.');
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
      const text = msg.message?.conversation || msg.message?.extendedTextMessage?.text || '';

      if (!text || text.trim() === '') continue;

      console.log(`📨 Message from ${chatId}: ${text}`);

      const mainNumber = process.env.YOUR_MAIN_NUMBER.replace('@s.whatsapp.net', '').replace('@lid', '');
      const fromNumber = chatId.replace('@s.whatsapp.net', '').replace('@lid', '');
      const isFromMain = fromNumber.includes(mainNumber) || mainNumber.includes(fromNumber);

      const replyFn = async (replyText) => {
        await sock.sendMessage(chatId, { text: replyText });
      };

      const msgObj = { from: chatId, body: text, reply: replyFn };

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
        await handleCommand(msgObj, text);
        return;
      }

      // For both chat and creative — use conversation history
      const tobiHistory = await getHistory(`tobi-${chatId}`);
      const historyMessages = tobiHistory.slice(-10).map(m => ({ role: m.role, content: m.content }));

      const systemPrompt = intent === 'creative'
        ? `${MAX_SYSTEM_PROMPT}
Tobi is asking you to create content for him. Write exactly what he asked for — no explanations, no preamble.
If he wants a WhatsApp status, write a clean status post.
If he wants a caption, write the caption.
If he wants a draft, write the draft.
Just deliver the content directly.`
        : `${MAX_SYSTEM_PROMPT}
Tobi is texting you directly. You are his PA having an ongoing conversation.
Remember what he's already told you in this conversation and don't repeat questions.
Be natural, brief, and genuinely helpful.
Don't keep asking about the same thing he already answered.
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
        await upsertContact(chatId, { name: 'Someone', relationship: '', tone: 'friendly', portfolio_shared: false, calendly_shared: false, message_count: 0 });
        contact = await getContact(chatId);
      }
      if (!contact) return;

      await saveMessage(chatId, 'user', text);
      const currentCount = contact?.message_count || 0;
      await supabase.from('contacts').update({ message_count: currentCount + 1 }).eq('chat_id', chatId);

      const history = await getHistory(chatId);

      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `${MAX_SYSTEM_PROMPT}
You are already in an ongoing conversation with ${contact.name}.
Their relationship to Tobi: ${contact.relationship || 'not specified'}
Tone to maintain: ${contact.tone}
Messages exchanged so far: ${contact.message_count}
Portfolio already shared: ${contact.portfolio_shared}
Calendly already shared: ${contact.calendly_shared}
Do NOT re-introduce yourself. Respond naturally.
Return only the reply, nothing else.`
          },
          ...history
        ]
      });

      const reply = response.choices[0].message.content.trim();
      await saveMessage(chatId, 'assistant', reply);

      if (reply.includes('tobidavid.dexcraft.agency')) await supabase.from('contacts').update({ portfolio_shared: true }).eq('chat_id', chatId);
      if (reply.includes(process.env.CALENDLY_LINK)) await supabase.from('contacts').update({ calendly_shared: true }).eq('chat_id', chatId);

      await sock.sendMessage(chatId, { text: reply });
      console.log(`✅ Max replied to ${contact.name}: ${reply}`);

      const contactName = contact.name !== 'Someone' ? contact.name : chatId;
      await sock.sendMessage(process.env.YOUR_MAIN_NUMBER.includes('@') ? process.env.YOUR_MAIN_NUMBER : `${process.env.YOUR_MAIN_NUMBER}@s.whatsapp.net`, {
        text: `🔔 *Max Update*\n\n*${contactName} said:* ${text}\n\n*Max replied:* ${reply}`
      });
    }
  });
}

connectToWhatsApp();