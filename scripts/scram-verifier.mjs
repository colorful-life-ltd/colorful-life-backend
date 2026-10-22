import {randomBytes,pbkdf2Sync,createHmac,createHash} from 'node:crypto';
export function scramVerifier(password,salt=randomBytes(16),iterations=4096){
 const salted=pbkdf2Sync(password,salt,iterations,32,'sha256');
 const client=createHmac('sha256',salted).update('Client Key').digest();
 const stored=createHash('sha256').update(client).digest('base64');
 const server=createHmac('sha256',salted).update('Server Key').digest('base64');
 return 'SCRAM-SHA-256$'+iterations+':'+salt.toString('base64')+'$'+stored+':'+server;
}
