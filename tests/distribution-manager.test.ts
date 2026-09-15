import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const python = (body: string) => spawnSync('python3', ['-c', `import runpy,tempfile,pathlib,zipfile,os\nm=runpy.run_path('distribution/prce')\n${body}`], { encoding: 'utf8' });
test('manager pins all gh API and release operations to github.com despite ambient host', () => {
 const r = python(`
import json,sys
from unittest.mock import patch
with tempfile.TemporaryDirectory() as d:
 root=pathlib.Path(d); log=root/'calls.jsonl'; fake=root/'gh'
 fake.write_text('#!'+sys.executable+'\\n'+'''import os,sys,json
args=sys.argv[1:]
with open(os.environ['FAKE_GH_LOG'],'a') as f: f.write(json.dumps({'args':args,'host':os.environ.get('GH_HOST')})+'\\\\n')
if args[0]=='api':
 endpoint=next(a for a in args if a.startswith('repos/'))
 if '/git/ref/' in endpoint: result={'object':{'type':'tag','sha':'b'*40}}
 elif '/git/tags/' in endpoint: result={'object':{'type':'commit','sha':'a'*40}}
 elif '/releases?' in endpoint: result=[[{'tag_name':'v1.2.3','draft':False,'prerelease':False,'assets':[{'name':'personal-mac.json'}]}]]
 else: result={'private':True}
else: result={'tagName':'v1.2.3','isDraft':False,'isPrerelease':False,'assets':[{'name':'personal-mac.json'}]}
print(json.dumps(result))
'''); fake.chmod(0o700)
 with patch.dict(os.environ, {'PATH':str(root),'GH_HOST':'evil.test','GH_TOKEN':'fixture-secret-not-real','FAKE_GH_LOG':str(log)}):
  assert m['resolve_release'](None)==('v1.2.3','a'*40)
  assert m['resolve_release']('v1.2.3')==('v1.2.3','a'*40)
  m['gh']('release','download','v1.2.3','--repo',m['REPO'],'--pattern','personal-mac.json','--dir',d)
 calls=[json.loads(line) for line in log.read_text().splitlines()]
 assert len(calls)==10
 for call in calls:
  assert call['host']=='github.com', 'ambient GH_HOST reached gh'
  args=call['args']
  if args[0]=='api': assert args[args.index('--hostname')+1]=='github.com'
  else: assert args[args.index('--repo')+1]=='github.com/'+m['REPO']
 assert 'fixture-secret-not-real' not in log.read_text()
`);
 assert.equal(r.status, 0, r.stderr);
 assert.doesNotMatch(r.stdout + r.stderr, /fixture-secret-not-real/);
});
test('manager command flow installs pinned authenticated fixture and rejects downgrade', () => {
 const r = python(`
from unittest.mock import patch
import json,plistlib,hashlib
with tempfile.TemporaryDirectory() as d:
 home=pathlib.Path(d)/'home'; home.mkdir(); src=pathlib.Path(d)/'source.zip'
 with zipfile.ZipFile(src,'w') as z:
  z.writestr(m['APP_NAME']+'/Contents/Info.plist',plistlib.dumps({'CFBundleShortVersionString':'1.2.3'}))
 payload=src.read_bytes(); name='PR-Context-Explorer-1.2.3-arm64.zip'
 manifest={'schema':1,'channel':'personal-unsigned','repository':m['REPO'],'tag':'v1.2.3','commit':'a'*40,'asset':{'name':name,'size':len(payload),'sha256':hashlib.sha256(payload).hexdigest()}}
 calls=[]
 def fake_gh(*args):
  calls.append(args); assert args[:2]==('release','download'); assert args[args.index('--repo')+1]==m['REPO']
  dest=pathlib.Path(args[args.index('--dir')+1]); asset=args[args.index('--pattern')+1]
  (dest/asset).write_bytes(json.dumps(manifest).encode() if asset=='personal-mac.json' else payload)
  return ''
 g=m['manage'].__globals__; g['gh']=fake_gh; g['resolve_release']=lambda _: ('v1.2.3','a'*40); g['running']=lambda:False; g['validate_app']=lambda p,v:None
 with patch.object(pathlib.Path,'home',return_value=home):
  m['manage']('install','v1.2.3')
  app=home/'Applications'/m['APP_NAME']; assert app.exists(); assert len(calls)==2
  (app/'Contents/Info.plist').write_bytes(plistlib.dumps({'CFBundleShortVersionString':'2.0.0'}))
  try: m['manage']('update','v1.2.3')
  except ValueError as e: assert 'Downgrades' in str(e)
  else: raise AssertionError('downgrade accepted')
  assert len(calls)==2
`);
 assert.equal(r.status, 0, r.stderr);
});
test('opt-in launchAgent enable/disable writes token-free per-user plist and unloads it', () => {
 const r = python(`
from unittest.mock import patch
from types import SimpleNamespace
import plistlib
with tempfile.TemporaryDirectory() as d:
 calls=[]
 def fake_run(args,**kwargs): calls.append(args); return SimpleNamespace(returncode=0)
 with patch.object(pathlib.Path,'home',return_value=pathlib.Path(d)),patch('subprocess.run',side_effect=fake_run),patch('shutil.which',return_value='/opt/homebrew/bin/gh'):
  m['launch_agent'](True)
  p=pathlib.Path(d)/'Library/LaunchAgents'/(m['LABEL']+'.plist')
  data=plistlib.loads(p.read_bytes()); assert data['ProgramArguments'][-1]=='update'; assert data['StartInterval']==21600
  assert 'RunAtLoad' not in data and 'TOKEN' not in str(data) and 'secret' not in str(data)
  assert p.stat().st_mode & 0o777 == 0o600
  m['launch_agent'](False); assert not p.exists()
 assert any('bootstrap' in c for c in calls) and any('bootout' in c for c in calls)
`);
 assert.equal(r.status, 0, r.stderr);
});
test('manager enforces exact source/channel/tag/commit and rejects downgrade', () => {
 const r = python(`
meta={'schema':1,'channel':'personal-unsigned','repository':m['REPO'],'tag':'v1.2.3','commit':'a'*40,'asset':{'name':'PR-Context-Explorer-1.2.3-arm64.zip','size':5,'sha256':'b'*64}}
m['validate_manifest'](meta,'v1.2.3','a'*40)
for field,bad in [('repository','evil/repo'),('channel','signed'),('tag','v1.2.4'),('commit','b'*40),('asset',{'name':'../bad.zip'})]:
 changed=dict(meta); changed[field]=bad
 try: m['validate_manifest'](changed,'v1.2.3','a'*40)
 except ValueError: pass
 else: raise AssertionError(field)
assert m['stable']('v1.10.0') > m['stable']('v1.2.0')
`);
 assert.equal(r.status, 0, r.stderr);
});
test('safe ZIP rejects traversal, symlink escapes and outside app members; checksum is enforced', () => {
  const r = python(`
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d)
 for name in ['../escape', '/absolute', 'Other.app/file']:
  z=p/'bad.zip'
  with zipfile.ZipFile(z,'w') as f: f.writestr(name, 'bad')
  try: m['extract_app'](z,p/'out')
  except ValueError: pass
  else: raise AssertionError(name)
 z=p/'bad.zip'
 with zipfile.ZipFile(z,'w') as f:
  i=zipfile.ZipInfo(m['APP_NAME']+'/link'); i.external_attr=(0o120777 << 16); f.writestr(i,'../../outside')
 try: m['extract_app'](z,p/'out')
 except ValueError: pass
 else: raise AssertionError('unsafe symlink')
 f=p/'asset'; f.write_bytes(b'bytes')
 try: m['verify_hash'](f, {'size':5,'sha256':'0'*64})
 except ValueError: pass
 else: raise AssertionError('checksum')
`);
  assert.equal(r.status, 0, r.stderr);
});
test('personal manager atomically swaps, rolls back failed validation and refuses running app', () => {
  const r = python(`
with tempfile.TemporaryDirectory() as d:
 p=pathlib.Path(d); old=p/'Applications'/'PR Context Explorer.app'; old.mkdir(parents=True); (old/'value').write_text('old')
 new=p/'new.app'; new.mkdir(); (new/'value').write_text('new')
 def fail(bundle):
  if bundle == old: raise ValueError('test post-swap validation failure')
 try: m['atomic_install'](new, old, lambda: False, fail)
 except ValueError: pass
 else: raise AssertionError('must fail validation')
 assert (old/'value').read_text()=='old'
 try: m['atomic_install'](new, old, lambda: True, lambda _: None)
 except ValueError: pass
 else: raise AssertionError('must refuse running app')
 assert (old/'value').read_text()=='old'
 m['atomic_install'](new, old, lambda: False, lambda _: None)
 assert (old/'value').read_text()=='new'
`);
  assert.equal(r.status, 0, r.stderr);
});
