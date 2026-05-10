require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');
const { createClient } = require('@supabase/supabase-js');
const express = require('express');
const cors = require('cors');
const app = express();
app.use(cors());
app.use(express.json());

app.post('/command', async (req, res) => {
  const { command } = req.body;
  if (!command) return res.status(400).json({ error: 'No command' });
  
  // Simulate a message from Tobi's main number
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

app.listen(3001, () => console.log('🌐 Dashboard API running on port 3001'));

const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

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
- Currently working on the Stuart AI project
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
- Stuart AI project
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
- You can reference things you know: "How's the Stuart AI project coming along?"

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
  const { data } = await supabase
    .from('contacts')
    .select('*')
    .eq('chat_id', chatId)
    .single();
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
  const { data } = await supabase
    .from('messages')
    .select('role, content')
    .eq('chat_id', chatId)
    .order('created_at', { ascending: true });
  return data || [];
}

// --- WHATSAPP CLIENT ---
const client = new Client({
authStrategy: new (require('whatsapp-web.js').NoAuth)(),
puppeteer: {
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  }
});

client.on('qr', (qr) => {
  console.log('📱 Scan this QR with your SECOND WhatsApp number:');
  qrcode.generate(qr, { small: true });
});

client.on('ready', () => {
  console.log('✅ Max is live and ready to work!');
});

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
    try {
      instruction = JSON.parse(raw);
    } catch {
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
    const chatId = `${number}@c.us`;

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
        {
          role: 'user',
          content: `Write the first message to ${instruction.recipient_name}. Context: ${instruction.message_context}.`
        }
      ]
    });

    const messageToSend = crafted.choices[0].message.content.trim();
    console.log(`✉️ Max crafted: ${messageToSend}`);

    await saveMessage(chatId, 'assistant', messageToSend);
    await client.sendMessage(chatId, messageToSend);
    console.log(`✅ Max messaged ${instruction.recipient_name} (${chatId})`);
    await msg.reply(`✅ Max has reached out to ${instruction.recipient_name}:\n\n_"${messageToSend}"_`);

  } catch (err) {
    console.error('❌ Error:', err.message);
    await msg.reply('❌ Something went wrong. Check the terminal.');
  }
}

client.on('message', async (msg) => {
  const fromMain = msg.from === process.env.YOUR_MAIN_NUMBER;
  const fromBot = msg.fromMe;

  if (fromBot) return;

  // --- COMMAND FROM TOBI ---
  if (fromMain) {
    const command = msg.body;
    console.log(`📩 Command from Tobi: ${command}`);

    // Check if Tobi is just chatting with Max
    const isJustChatting = !command.toLowerCase().includes('message ') &&
      !command.toLowerCase().includes('send ') &&
      !command.toLowerCase().includes('follow up') &&
      !command.toLowerCase().includes('reach out')

    if (isJustChatting) {
      // Max chats back with Tobi naturally
      const response = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [
          {
            role: 'system',
            content: `${MAX_SYSTEM_PROMPT}
Tobi is texting you directly right now. You are his PA.
Chat with him naturally — ask how things are going, give heads up on anything relevant, be proactive.
If he just says "hey" or "hi", greet him warmly and check in on him.
You can reference things you know about him — Stuart AI project, Jetherverse, Chidera, his music, his goals.
Keep it brief and natural — this is WhatsApp.
Return only your reply, nothing else.`
          },
          { role: 'user', content: command }
        ]
      });

      const reply = response.choices[0].message.content.trim();
      await msg.reply(reply);
      return;
    }

    await handleCommand(msg, command);
    return;
  }

  // --- REPLY FROM SOMEONE ELSE ---
  const chatId = msg.from;
  const theirMessage = msg.body;

  if (!theirMessage || theirMessage.trim() === '') {
    console.log(`⚠️ Ignored empty message from ${chatId}`);
    return;
  }

  console.log(`💬 Reply from ${chatId}: ${theirMessage}`);

  let contact = await getContact(chatId);
  if (!contact) {
    await upsertContact(chatId, {
      name: 'Someone',
      relationship: '',
      tone: 'friendly',
      portfolio_shared: false,
      calendly_shared: false,
      message_count: 0
    });
    contact = await getContact(chatId);
  }
  if (!contact) {
    console.log(`⚠️ Could not create contact for ${chatId}`);
    return;
  }

  await saveMessage(chatId, 'user', theirMessage);

  const currentCount = contact?.message_count || 0;
  await supabase
    .from('contacts')
    .update({ message_count: currentCount + 1 })
    .eq('chat_id', chatId);

  const history = await getHistory(chatId);

  try {
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

IMPORTANT:
- Do NOT re-introduce yourself
- Do NOT share portfolio again if already shared
- Do NOT share Calendly again if already shared
- Read their message carefully and respond to exactly what they said
- Only share portfolio if genuinely relevant and not yet shared
- Only share Calendly if they're clearly ready to book and not yet shared
- Keep it natural and conversational
Return only the reply, nothing else.`
        },
        ...history
      ]
    });

    const reply = response.choices[0].message.content.trim();

    await saveMessage(chatId, 'assistant', reply);

    if (reply.includes('tobidavid.dexcraft.agency')) {
      await supabase.from('contacts').update({ portfolio_shared: true }).eq('chat_id', chatId);
    }
    if (reply.includes(process.env.CALENDLY_LINK)) {
      await supabase.from('contacts').update({ calendly_shared: true }).eq('chat_id', chatId);
    }

    await client.sendMessage(chatId, reply);
    console.log(`✅ Max replied to ${contact.name}: ${reply}`);

    const contactName = contact.name && contact.name !== 'Someone' ? contact.name : chatId;
    await client.sendMessage(
      process.env.YOUR_MAIN_NUMBER,
      `🔔 *Max Update*\n\n*${contactName} said:* ${theirMessage}\n\n*Max replied:* ${reply}`
    );

  } catch (err) {
    console.error('❌ Reply error:', err.message);
  }
});

client.initialize();

client.initialize();