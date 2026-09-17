import time
import requests
from supabase import create_client

SUPABASE_URL = 'https://kfgswynickhywzhneltu.supabase.co'
SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtmZ3N3eW5pY2toeXd6aG5lbHR1Iiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTczNTUwNjA1MywiZXhwIjoyMDUxMDgyMDUzfQ.0Fu7UKwXf9ZAPQ0OTCxpXh6P7aWGW1A8jTX8FxZqhis'
BSB_AGENT_KEY = 'bdf2422d9dd8f215a583c1a37727d658'
BUCKET_NAME = 'bsb-media'

sb = create_client(SUPABASE_URL, SERVICE_KEY)

def get_bsb_session():
    s = requests.Session()
    res = s.post('https://www.bestsmsbulk.com/pro-livechat/api/validate-key.php', data={'secret_key': BSB_AGENT_KEY, 'force_login': '1'}, timeout=10)
    data = res.json()
    if not data.get('success'):
        print('BSB login failed:', data)
        return None
    return s

def sync_active_media():
    session = get_bsb_session()
    if not session:
        return

    # 1. Get all active conversations
    conv_res = sb.rpc('get_bsb_recent_conversations', {'hours_lookback': 24, 'min_hours_old': 2.0}).execute()
    contacts = [c['contact'] for c in (conv_res.data or [])]
    if not contacts:
        print("No active contacts.")
        return

    print(f"Found {len(contacts)} active contacts. Fetching media messages...")

    # 2. Get media messages for these contacts (prioritize audio/voice)
    media_items = []
    chunk_size = 60
    for i in range(0, len(contacts), chunk_size):
        chunk = contacts[i:i+chunk_size]
        res = sb.from_('bsb_messages')\
            .select('chat_id, media_type, media_url, contact')\
            .in_('contact', chunk)\
            .in_('media_type', ['audio', 'image'])\
            .execute()
        for row in (res.data or []):
            murl = row.get('media_url') or ''
            # Only process if not already synced to supabase storage
            if not murl.startswith(f'{SUPABASE_URL}/storage/v1/object/public/{BUCKET_NAME}/'):
                media_items.append(row)

    # Sort audio first
    media_items.sort(key=lambda x: 0 if x.get('media_type') == 'audio' else 1)
    print(f"Total unsynced media items to process: {len(media_items)}")

    synced_count = 0
    fail_count = 0

    for idx, item in enumerate(media_items):
        chat_id = item['chat_id']
        m_type = item['media_type']
        ext = 'ogg' if m_type == 'audio' else 'jpg'
        filename = f"{chat_id}.{ext}"

        try:
            # Download from BSB OneBox
            media_resp = session.get(f"https://www.bestsmsbulk.com/pro-livechat/php/get-chat-media.php?chatid={chat_id}", timeout=12)
            c_type = media_resp.headers.get('Content-Type', '')
            
            # If session expired or redirected
            if media_resp.status_code != 200 or 'text/html' in c_type:
                # Re-login once
                session = get_bsb_session()
                if not session:
                    break
                media_resp = session.get(f"https://www.bestsmsbulk.com/pro-livechat/php/get-chat-media.php?chatid={chat_id}", timeout=12)
                c_type = media_resp.headers.get('Content-Type', '')

            if media_resp.status_code == 200 and 'text/html' not in c_type and len(media_resp.content) > 100:
                # Upload to Supabase Storage
                up_resp = requests.post(
                    f"{SUPABASE_URL}/storage/v1/object/{BUCKET_NAME}/{filename}",
                    headers={
                        'Authorization': f'Bearer {SERVICE_KEY}',
                        'Content-Type': c_type or ('audio/ogg' if ext == 'ogg' else 'image/jpeg'),
                        'x-upsert': 'true'
                    },
                    data=media_resp.content,
                    timeout=15
                )
                if up_resp.status_code in [200, 201]:
                    pub_url = f"{SUPABASE_URL}/storage/v1/object/public/{BUCKET_NAME}/{filename}"
                    sb.from_('bsb_messages').update({'media_url': pub_url}).eq('chat_id', chat_id).execute()
                    synced_count += 1
                    if synced_count % 10 == 0 or idx < 5:
                        print(f"[{synced_count}/{len(media_items)}] Synced {m_type} {filename} ({len(media_resp.content)} bytes)")
                else:
                    fail_count += 1
            else:
                fail_count += 1
        except Exception as e:
            fail_count += 1
            print(f"Error syncing {chat_id}: {e}")

    print(f"Done media sync batch: {synced_count} succeeded, {fail_count} failed.")

if __name__ == '__main__':
    sync_active_media()
