import os
import time
import logging
import requests
from supabase import create_client

try:
    from core.http_client import post_with_retry
except ImportError:
    from http_client import post_with_retry

logging.basicConfig(
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    level=logging.INFO
)
logger = logging.getLogger("sync_media_daemon")

def _load_env_file():
    """Load KEY=VALUE lines from the first existing .env (real environment wins)."""
    here = os.path.dirname(os.path.abspath(__file__))
    root = here
    for path in (os.path.join(here, ".env"), os.path.join(root, "core", ".env"), "/home/user/Projects/Fady_bot/.env"):
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                name, value = line.split("=", 1)
                name, value = name.strip(), value.strip()
                if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
                    value = value[1:-1]
                os.environ.setdefault(name, value)
        break


_load_env_file()

SUPABASE_URL = os.environ.get('SUPABASE_URL', 'https://kfgswynickhywzhneltu.supabase.co')
SERVICE_KEY = os.environ.get('SUPABASE_SERVICE_ROLE_KEY', '')
if not SERVICE_KEY:
    raise RuntimeError('Set SUPABASE_SERVICE_ROLE_KEY in core/.env')
BSB_AGENT_KEY = os.environ.get('BSB_MEDIA_AGENT_KEY') or os.environ.get('BSB_AGENT_KEY', '')
BUCKET_NAME = 'bsb-media'

sb = create_client(SUPABASE_URL, SERVICE_KEY)

def get_bsb_session():
    s = requests.Session()
    res = post_with_retry('https://www.bestsmsbulk.com/pro-livechat/api/validate-key.php', data={'secret_key': BSB_AGENT_KEY, 'force_login': '1'}, timeout=10, session=s)
    data = res.json()
    if not data.get('success'):
        logger.error('BSB login failed: %s', data)
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
        logger.info("No active contacts.")
        return

    logger.info("Found %d active contacts. Fetching media messages...", len(contacts))

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
    logger.info("Total unsynced media items to process: %d", len(media_items))

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
                up_resp = post_with_retry(
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
                        logger.info("[%d/%d] Synced %s %s (%d bytes)", synced_count, len(media_items), m_type, filename, len(media_resp.content))
                else:
                    fail_count += 1
            else:
                fail_count += 1
        except Exception as e:
            fail_count += 1
            logger.error("Error syncing %s: %s", chat_id, e)

    logger.info("Done media sync batch: %d succeeded, %d failed.", synced_count, fail_count)

if __name__ == '__main__':
    sync_active_media()
