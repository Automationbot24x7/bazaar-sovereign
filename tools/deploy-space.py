"""Deploy the game to a Hugging Face Space (Docker, free CPU tier).

Usage (from the repo root):
    python tools/deploy-space.py <hf-username> [space-name] [--public]

Reads the HF write token from Credentials/hf-token.txt, the NEAR key from
Credentials/<NEAR_ACCOUNT_ID>.json and the AI key from the file named by
ANTHROPIC_KEY_FILE in .env. Keys go into the Space's encrypted secrets; only
the app (Dockerfile, server, public) is uploaded. The Space starts private;
pass --public when the game is ready for judges.
"""
import json, os, re, shutil, sys, tempfile
from huggingface_hub import HfApi

args = [a for a in sys.argv[1:] if not a.startswith('--')]
if not args:
    sys.exit(__doc__)
user, name = args[0], (args[1] if len(args) > 1 else 'bazaar-sovereign')
public = '--public' in sys.argv
repo_id = f'{user}/{name}'

env = dict(re.findall(r'^([A-Z_]+)=(.*)$', open('.env', encoding='utf-8').read(), re.M))
token = open('Credentials/hf-token.txt', encoding='utf-8').read().strip()
root = env['NEAR_ACCOUNT_ID'].strip()
near_key = json.load(open(os.path.join(env.get('NEAR_KEY_DIR', 'Credentials').strip(), f'{root}.json'), encoding='utf-8'))['private_key']
ai_key = open(env['ANTHROPIC_KEY_FILE'].strip(), encoding='utf-8').read().strip()

api = HfApi(token=token)
api.create_repo(repo_id, repo_type='space', space_sdk='docker', private=not public, exist_ok=True)
host = f"https://{re.sub(r'[^a-z0-9]+', '-', repo_id.lower().replace('/', '-'))}.hf.space"

for k, v in {'NEAR_ACCOUNT_ID': root, 'NEAR_PRIVATE_KEY': near_key, 'ANTHROPIC_API_KEY': ai_key}.items():
    api.add_space_secret(repo_id, k, v)
for k, v in {'PUBLIC_URL': host, 'LIVE_TABLES': '3', 'AI_DAILY_USD': '25', 'AI_SPEND_FILE': '/tmp/ai-spend.json'}.items():
    api.add_space_variable(repo_id, k, v)

stage = tempfile.mkdtemp(prefix='space-')
for f in ['Dockerfile', 'package.json', 'package-lock.json', '.dockerignore']:
    shutil.copy(f, stage)
for d in ['server', 'public']:
    shutil.copytree(d, os.path.join(stage, d))
open(os.path.join(stage, 'README.md'), 'w', encoding='utf-8').write(
    '---\ntitle: Bazaar Sovereign\nemoji: 🐫\ncolorFrom: yellow\ncolorTo: red\nsdk: docker\napp_port: 8080\npinned: false\n'
    'short_description: A living bazaar where every merchant is a NEAR NFT\n---\n\n'
    'Bazaar Sovereign: a trading game on NEAR testnet. Every merchant is an NFT charter that owns its own wallet.\n')
api.upload_folder(repo_id=repo_id, repo_type='space', folder_path=stage, commit_message='Deploy Bazaar Sovereign',
                  delete_patterns=['server/**', 'public/**'])
shutil.rmtree(stage, ignore_errors=True)
print(f'Deployed {repo_id} ({"public" if public else "private"}) -> {host}')
print(f'Build logs: https://huggingface.co/spaces/{repo_id}?logs=build')
