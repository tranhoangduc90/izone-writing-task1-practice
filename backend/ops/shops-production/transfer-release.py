"""Upload owned production code and ERP roster without printing private data."""
import importlib.util,pathlib,json
spec=importlib.util.spec_from_file_location('trusted_ssh','E:/Codex-Projects/New project/services/shared/ssh-keyring-transfer.py');trusted=importlib.util.module_from_spec(spec);spec.loader.exec_module(trusted)
here=pathlib.Path(__file__).parent;private=pathlib.Path('C:/Users/ADMIN/Documents/Codex/shops-handout-preview-20261024/production-private')
client,password=trusted.connect('vps_1');password=''
try:
 with client.open_sftp() as sftp:
  base='/opt/izone-shops-writing/releases/20261024.1'
  for folder in ['/opt/izone-shops-writing','/opt/izone-shops-writing/releases',base,base+'/candidate']:
   try:sftp.mkdir(folder,mode=0o700)
   except OSError:pass
  for p in [here/'server.mjs',here/'atomic-results.mjs',here/'install-runtime.py',private/'erp-roster.private.json']:
   target=base+('/candidate/' if p.suffix=='.mjs' else '/')+p.name;sftp.put(str(p),target);sftp.chmod(target,0o600 if '.private.' in p.name else 0o644)
 _,stdout,stderr=client.exec_command('python3 '+base+'/install-runtime.py',timeout=180)
 data=stdout.read().decode();error=stderr.read().decode()
 if stdout.channel.recv_exit_status():raise RuntimeError(error[-1400:])
 receipt=json.loads(data);(private/'runtime-receipt.json').write_text(json.dumps(receipt,indent=2));print(json.dumps(receipt))
finally:client.close()
