import { useState, useEffect, useRef } from 'react'
import { createClient } from '@supabase/supabase-js'

const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_KEY
)

export default function Dashboard() {
  const [contacts, setContacts] = useState([])
  const [selected, setSelected] = useState(null)
  const [messages, setMessages] = useState([])
  const [loading, setLoading] = useState(true)
  const [command, setCommand] = useState('')
  const [sending, setSending] = useState(false)
  const [showAddContact, setShowAddContact] = useState(false)
  const [editingContact, setEditingContact] = useState(null)
  const [formData, setFormData] = useState({ name: '', number: '', relationship: '', tone: 'friendly' })
  const messagesEndRef = useRef(null)

  // Fetch contacts
  useEffect(() => {
    fetchContacts()
    const channel = supabase
      .channel('messages')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages' }, () => {
        if (selected) fetchMessages(selected.chat_id)
        fetchContacts()
      })
      .subscribe()
    return () => supabase.removeChannel(channel)
  }, [selected])

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  async function fetchContacts() {
    const { data } = await supabase
      .from('contacts')
      .select('*')
      .order('created_at', { ascending: false })
    setContacts(data || [])
    setLoading(false)
  }

  async function fetchMessages(chatId) {
    const { data } = await supabase
      .from('messages')
      .select('*')
      .eq('chat_id', chatId)
      .order('created_at', { ascending: true })
    setMessages(data || [])
  }

  async function saveContact() {
    if (!formData.name || !formData.number) {
      alert('Name and number are required')
      return
    }

    let number = formData.number.replace(/\D/g, '')
    if (number.startsWith('0')) number = '234' + number.slice(1)
    const chatId = `${number}@s.whatsapp.net`

    try {
      if (editingContact) {
        // Update existing contact
        await supabase
          .from('contacts')
          .update({
            name: formData.name,
            relationship: formData.relationship,
            tone: formData.tone,
            chat_id: chatId
          })
          .eq('chat_id', editingContact.chat_id)
      } else {
        // Add new contact
        await supabase.from('contacts').insert({
          chat_id: chatId,
          name: formData.name,
          relationship: formData.relationship,
          tone: formData.tone,
          message_count: 0
        })
      }
      
      fetchContacts()
      setShowAddContact(false)
      setEditingContact(null)
      setFormData({ name: '', number: '', relationship: '', tone: 'friendly' })
    } catch (err) {
      console.error('Error saving contact:', err)
      alert('Failed to save contact')
    }
  }

  async function deleteContact(chatId) {
    if (!confirm('Delete this contact?')) return
    try {
      await supabase.from('contacts').delete().eq('chat_id', chatId)
      fetchContacts()
      if (selected?.chat_id === chatId) setSelected(null)
    } catch (err) {
      alert('Failed to delete contact')
    }
  }

  function editContact(contact) {
    setEditingContact(contact)
    setFormData({
      name: contact.name || '',
      number: contact.chat_id.replace('@s.whatsapp.net', ''),
      relationship: contact.relationship || '',
      tone: contact.tone || 'friendly'
    })
    setShowAddContact(true)
  }

  async function sendCommand(cmd) {
    const text = cmd || command
    if (!text.trim()) return
    setSending(true)
    try {
      await fetch('http://localhost:3001/command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: text })
      })
      setCommand('')
      setTimeout(() => fetchContacts(), 2000)
    } catch (err) {
      alert('Could not reach Max. Make sure the bot is running.')
    }
    setSending(false)
  }

  function selectContact(contact) {
    setSelected(contact)
    fetchMessages(contact.chat_id)
  }

  const totalMessages = contacts.reduce((a, c) => a + (c.message_count || 0), 0)
  const portfolioShared = contacts.filter(c => c.portfolio_shared).length
  const calendlyShared = contacts.filter(c => c.calendly_shared).length

  return (
    <div style={{ display: 'flex', height: '100vh', overflow: 'hidden', background: '#0a0a0a', color: '#f0f0f0', fontFamily: "'DM Mono', monospace" }}>
      
      {/* SIDEBAR */}
      <div style={{ width: '320px', borderRight: '1px solid #222', display: 'flex', flexDirection: 'column', background: '#0a0a0a', flexShrink: 0, overflowY: 'auto' }}>
        {/* Header */}
        <div style={{ padding: '32px 24px', borderBottom: '1px solid #222' }}>
          <div style={{ fontSize: '24px', fontWeight: 800, fontFamily: "'Syne', sans-serif", color: '#c8f562', letterSpacing: '-1px', marginBottom: '4px' }}>MAX</div>
          <div style={{ fontSize: '11px', color: '#888', fontWeight: 600, letterSpacing: '0.5px', display: 'flex', alignItems: 'center', gap: '6px' }}>
            <span style={{ display: 'inline-block', width: '6px', height: '6px', borderRadius: '50%', background: '#22c55e', boxShadow: '0 0 6px #22c55e' }} />
            TOBI'S PA — LIVE
          </div>
        </div>

        {/* Add Contact Button */}
        <div style={{ padding: '16px 12px' }}>
          <button
            onClick={() => {
              setEditingContact(null)
              setFormData({ name: '', number: '', relationship: '', tone: 'friendly' })
              setShowAddContact(true)
            }}
            style={{
              width: '100%', padding: '12px 16px', borderRadius: '8px', border: 'none',
              background: '#c8f562', color: '#0a0a0a', fontWeight: 700,
              fontFamily: "'Syne', sans-serif", cursor: 'pointer', fontSize: '13px',
              transition: 'all 0.2s'
            }}
            onMouseOver={(e) => e.target.style.opacity = '0.9'}
            onMouseOut={(e) => e.target.style.opacity = '1'}
          >
            + Add Contact
          </button>
        </div>

        {/* Contacts List */}
        <div style={{ flex: 1, overflowY: 'auto', padding: '8px 12px' }}>
          {loading && <div style={{ padding: '16px', fontSize: '12px', color: '#888' }}>Loading...</div>}
          {!loading && contacts.length === 0 && (
            <div style={{ padding: '16px', fontSize: '12px', color: '#888', textAlign: 'center' }}>No contacts yet</div>
          )}
          {contacts.map(contact => (
            <div
              key={contact.chat_id}
              onClick={() => selectContact(contact)}
              style={{
                padding: '14px', borderRadius: '8px', marginBottom: '6px', cursor: 'pointer',
                background: selected?.chat_id === contact.chat_id ? '#1a1a1a' : 'transparent',
                border: selected?.chat_id === contact.chat_id ? '1px solid #333' : '1px solid transparent',
                transition: 'all 0.15s',
                position: 'relative',
                group: 'relative'
              }}
              onMouseOver={(e) => {
                if (selected?.chat_id !== contact.chat_id) {
                  e.currentTarget.style.background = '#111'
                  e.currentTarget.style.borderColor = '#222'
                }
              }}
              onMouseOut={(e) => {
                if (selected?.chat_id !== contact.chat_id) {
                  e.currentTarget.style.background = 'transparent'
                  e.currentTarget.style.borderColor = 'transparent'
                }
              }}
            >
              <div style={{ fontSize: '13px', fontWeight: 600, fontFamily: "'Syne', sans-serif", marginBottom: '4px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                {contact.name || 'Unknown'}
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    editContact(contact)
                  }}
                  style={{
                    background: 'none', border: 'none', color: '#888', cursor: 'pointer',
                    fontSize: '10px', padding: '0 4px', opacity: 0, transition: 'opacity 0.2s'
                  }}
                  onMouseOver={(e) => e.target.style.opacity = '1'}
                >
                  ✎
                </button>
              </div>
              <div style={{ fontSize: '11px', color: '#888', marginBottom: '6px', display: 'flex', justifyContent: 'space-between' }}>
                <span>{contact.message_count || 0} msgs</span>
              </div>
              {contact.relationship && (
                <div style={{ fontSize: '10px', color: '#666', marginBottom: '4px' }}>{contact.relationship}</div>
              )}
              <div style={{ fontSize: '9px', color: '#555', display: 'flex', gap: '6px' }}>
                {contact.portfolio_shared && <span style={{ background: 'rgba(124,58,237,0.1)', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(124,58,237,0.2)' }}>portfolio</span>}
                {contact.calendly_shared && <span style={{ background: 'rgba(34,197,94,0.1)', padding: '2px 6px', borderRadius: '4px', border: '1px solid rgba(34,197,94,0.2)' }}>booked</span>}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* MAIN CONTENT */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
        
        {/* TOPBAR */}
        <div style={{ padding: '24px 32px', borderBottom: '1px solid #222', display: 'flex', justifyContent: 'space-between', alignItems: 'center', background: '#0a0a0a' }}>
          <div>
            <div style={{ fontSize: '18px', fontWeight: 700, fontFamily: "'Syne', sans-serif" }}>
              {selected ? selected.name || 'Unknown' : 'Max Dashboard'}
            </div>
            <div style={{ fontSize: '11px', color: '#888', marginTop: '4px', letterSpacing: '0.5px' }}>
              {selected ? `${selected.relationship || 'Contact'} • ${selected.tone || 'friendly'} tone` : 'Select a conversation'}
            </div>
          </div>
          <div style={{ display: 'flex', gap: '24px' }}>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '24px', fontWeight: 800, fontFamily: "'Syne', sans-serif", color: '#c8f562' }}>{contacts.length}</div>
              <div style={{ fontSize: '10px', color: '#888', marginTop: '4px', letterSpacing: '0.5px' }}>CONTACTS</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '24px', fontWeight: 800, fontFamily: "'Syne', sans-serif", color: '#c8f562' }}>{totalMessages}</div>
              <div style={{ fontSize: '10px', color: '#888', marginTop: '4px', letterSpacing: '0.5px' }}>MESSAGES</div>
            </div>
          </div>
        </div>

        {/* MESSAGES */}
        {!selected ? (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', color: '#666', gap: '12px' }}>
            <div style={{ fontSize: '16px', fontFamily: "'Syne', sans-serif", color: '#888' }}>No conversation selected</div>
            <div style={{ fontSize: '12px' }}>Pick a contact from the sidebar to view messages</div>
          </div>
        ) : (
          <div style={{ flex: 1, overflowY: 'auto', padding: '24px 32px', display: 'flex', flexDirection: 'column', gap: '12px' }}>
            {messages.map((m, i) => (
              <div key={i} style={{ display: 'flex', justifyContent: m.role === 'assistant' ? 'flex-end' : 'flex-start' }}>
                <div style={{ maxWidth: '65%' }}>
                  <div style={{ fontSize: '10px', color: '#888', marginBottom: '4px', textAlign: m.role === 'assistant' ? 'right' : 'left', letterSpacing: '0.3px' }}>
                    {m.role === 'assistant' ? 'MAX' : (selected.name || 'THEM').toUpperCase()}
                  </div>
                  <div style={{
                    padding: '12px 16px', borderRadius: m.role === 'assistant' ? '16px 16px 4px 16px' : '16px 16px 16px 4px',
                    background: m.role === 'assistant' ? '#c8f562' : '#1a1a1a',
                    color: m.role === 'assistant' ? '#0a0a0a' : '#f0f0f0',
                    fontSize: '13px', lineHeight: '1.6',
                    border: m.role === 'assistant' ? 'none' : '1px solid #222'
                  }}>
                    {m.content}
                  </div>
                </div>
              </div>
            ))}
            <div ref={messagesEndRef} />
          </div>
        )}

        {/* COMMAND INPUT */}
        <div style={{ padding: '16px 32px', borderTop: '1px solid #222', background: '#0a0a0a', display: 'flex', gap: '12px' }}>
          <input
            type="text"
            value={command}
            onChange={e => setCommand(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && sendCommand()}
            placeholder="Type a command for Max... e.g. Message Chidera to check on her"
            style={{
              flex: 1, padding: '12px 16px', borderRadius: '8px', border: '1px solid #222',
              background: '#111', color: '#f0f0f0', fontFamily: "'DM Mono', monospace",
              fontSize: '12px', outline: 'none', transition: 'border-color 0.2s'
            }}
            onFocus={(e) => e.target.style.borderColor = '#333'}
            onBlur={(e) => e.target.style.borderColor = '#222'}
          />
          <button
            onClick={() => sendCommand()}
            style={{
              padding: '12px 28px', borderRadius: '8px', border: 'none',
              background: sending ? '#333' : '#c8f562', color: sending ? '#888' : '#0a0a0a',
              fontFamily: "'Syne', sans-serif", fontWeight: 700, fontSize: '13px',
              cursor: sending ? 'not-allowed' : 'pointer', transition: 'all 0.2s'
            }}
          >
            {sending ? 'Sending...' : 'Send'}
          </button>
        </div>

        {/* STATS */}
        <div style={{ padding: '16px 32px', borderTop: '1px solid #222', background: '#0a0a0a', display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: '12px' }}>
          <div style={{ padding: '16px', borderRadius: '8px', background: '#111', border: '1px solid #222' }}>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: "'Syne', sans-serif", color: '#c8f562' }}>{contacts.length}</div>
            <div style={{ fontSize: '10px', color: '#888', marginTop: '4px', letterSpacing: '0.5px' }}>TOTAL CONTACTS</div>
          </div>
          <div style={{ padding: '16px', borderRadius: '8px', background: '#111', border: '1px solid #222' }}>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: "'Syne', sans-serif", color: '#c8f562' }}>{totalMessages}</div>
            <div style={{ fontSize: '10px', color: '#888', marginTop: '4px', letterSpacing: '0.5px' }}>TOTAL MESSAGES</div>
          </div>
          <div style={{ padding: '16px', borderRadius: '8px', background: '#111', border: '1px solid #222' }}>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: "'Syne', sans-serif", color: '#c8f562' }}>{portfolioShared}</div>
            <div style={{ fontSize: '10px', color: '#888', marginTop: '4px', letterSpacing: '0.5px' }}>PORTFOLIO SHARED</div>
          </div>
          <div style={{ padding: '16px', borderRadius: '8px', background: '#111', border: '1px solid #222' }}>
            <div style={{ fontSize: '20px', fontWeight: 800, fontFamily: "'Syne', sans-serif", color: '#c8f562' }}>{calendlyShared}</div>
            <div style={{ fontSize: '10px', color: '#888', marginTop: '4px', letterSpacing: '0.5px' }}>MEETINGS BOOKED</div>
          </div>
        </div>
      </div>

      {/* ADD/EDIT CONTACT MODAL */}
      {showAddContact && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex',
          alignItems: 'center', justifyContent: 'center', zIndex: 1000
        }} onClick={() => setShowAddContact(false)}>
          <div style={{
            background: '#1a1a1a', borderRadius: '12px', padding: '32px', maxWidth: '400px',
            width: '90%', border: '1px solid #222', boxShadow: '0 20px 60px rgba(0,0,0,0.5)'
          }} onClick={(e) => e.stopPropagation()}>
            <h2 style={{ fontSize: '18px', fontWeight: 700, fontFamily: "'Syne', sans-serif", marginBottom: '24px' }}>
              {editingContact ? 'Edit Contact' : 'Add New Contact'}
            </h2>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 600 }}>Name</label>
                <input
                  type="text"
                  value={formData.name}
                  onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                  placeholder="e.g., Chidera"
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: '6px', border: '1px solid #222',
                    background: '#111', color: '#f0f0f0', fontSize: '13px', outline: 'none'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 600 }}>WhatsApp Number</label>
                <input
                  type="tel"
                  value={formData.number}
                  onChange={(e) => setFormData({ ...formData, number: e.target.value })}
                  placeholder="e.g., 08012345678"
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: '6px', border: '1px solid #222',
                    background: '#111', color: '#f0f0f0', fontSize: '13px', outline: 'none'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 600 }}>Relationship (Optional)</label>
                <input
                  type="text"
                  value={formData.relationship}
                  onChange={(e) => setFormData({ ...formData, relationship: e.target.value })}
                  placeholder="e.g., Best friend, Client, Manager"
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: '6px', border: '1px solid #222',
                    background: '#111', color: '#f0f0f0', fontSize: '13px', outline: 'none'
                  }}
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '12px', color: '#888', marginBottom: '6px', fontWeight: 600 }}>Tone</label>
                <select
                  value={formData.tone}
                  onChange={(e) => setFormData({ ...formData, tone: e.target.value })}
                  style={{
                    width: '100%', padding: '10px 14px', borderRadius: '6px', border: '1px solid #222',
                    background: '#111', color: '#f0f0f0', fontSize: '13px', outline: 'none'
                  }}
                >
                  <option value="friendly">Friendly</option>
                  <option value="professional">Professional</option>
                  <option value="casual">Casual</option>
                  <option value="formal">Formal</option>
                </select>
              </div>

              <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                <button
                  onClick={() => {
                    setShowAddContact(false)
                    setEditingContact(null)
                  }}
                  style={{
                    flex: 1, padding: '10px 16px', borderRadius: '6px', border: '1px solid #222',
                    background: 'transparent', color: '#f0f0f0', fontFamily: "'Syne', sans-serif",
                    fontWeight: 600, cursor: 'pointer', fontSize: '13px'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={saveContact}
                  style={{
                    flex: 1, padding: '10px 16px', borderRadius: '6px', border: 'none',
                    background: '#c8f562', color: '#0a0a0a', fontFamily: "'Syne', sans-serif",
                    fontWeight: 600, cursor: 'pointer', fontSize: '13px'
                  }}
                >
                  {editingContact ? 'Update' : 'Add'}
                </button>
                {editingContact && (
                  <button
                    onClick={() => {
                      deleteContact(editingContact.chat_id)
                      setShowAddContact(false)
                      setEditingContact(null)
                    }}
                    style={{
                      padding: '10px 16px', borderRadius: '6px', border: '1px solid #ff4444',
                      background: 'transparent', color: '#ff4444', fontFamily: "'Syne', sans-serif",
                      fontWeight: 600, cursor: 'pointer', fontSize: '13px'
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
