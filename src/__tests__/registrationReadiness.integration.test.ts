import assert from 'node:assert/strict'
import { after, before, it } from 'node:test'
import { randomUUID } from 'node:crypto'
import app from '../app.js'
import { prisma } from '../prisma/runtime.js'
import { config } from '../config/index.js'
import { setVerificationEmailSenderForTests, setPasswordResetEmailSenderForTests } from '../services/emailService.js'
import jwt from 'jsonwebtoken'

let server: ReturnType<typeof app.listen>, base: string, verifyUrl = '', resetUrl = '', userId = 0
const email = `readiness-${randomUUID()}@example.test`, password = 'SecurePass1!'
let restoreVerify: () => void, restoreReset: () => void
before(async () => {
 config.REGISTRATION_ENABLED = true
 restoreVerify = setVerificationEmailSenderForTests(async ({verificationUrl}) => { verifyUrl=verificationUrl })
 restoreReset = setPasswordResetEmailSenderForTests(async ({resetUrl: url}) => { resetUrl=url })
 server=app.listen(0, '127.0.0.1'); await new Promise<void>(r=>server.once('listening',r))
 base=`http://127.0.0.1:${(server.address() as {port:number}).port}`
})
after(async () => {
 restoreVerify();restoreReset();
 if(userId){await prisma.refreshSession.deleteMany({where:{userId}});await prisma.emailVerificationToken.deleteMany({where:{userId}});await prisma.passwordResetToken.deleteMany({where:{userId}});await prisma.user.deleteMany({where:{id:userId}})}
 await prisma.$disconnect();await new Promise<void>(r=>server.close(()=>r()))
})
async function post(path:string, body:unknown){const response=await fetch(base+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {response,body:response.status===204?null:await response.json()}}
it('generic signup, verification, session, reset and negative paths',async()=>{
 const attackerPassword='AttackerPass1!'
 const first=await post('/auth/signup',{email,password:attackerPassword});assert.equal(first.response.status,202);assert.equal(first.body.token,undefined)
 const user=await prisma.user.findUniqueOrThrow({where:{email}});userId=user.id
 const duplicate=await post('/auth/signup',{email:email.toUpperCase(),password});assert.equal(duplicate.response.status,202);assert.deepEqual(duplicate.body,first.body)
 const unverified=await post('/auth/login',{email,password:attackerPassword});assert.equal(unverified.response.status,401);assert.equal(unverified.body.token,undefined)
 // Simulate a previous backend verifier that merely flips the verification bit.
 // The supplied signup password must still be unable to authenticate.
 await prisma.user.update({where:{id:userId},data:{emailVerified:true}})
 assert.equal((await post('/auth/login',{email,password:attackerPassword})).response.status,401)
 await prisma.user.update({where:{id:userId},data:{emailVerified:false}})
 const legacy=jwt.sign({id:userId,role:'CUSTOMER',credentialVersion:user.credentialVersion},config.JWT_SECRET)
 const denied=await fetch(base+'/users/me',{headers:{authorization:`Bearer ${legacy}`}});assert.equal(denied.status,401)
 assert.ok(verifyUrl);const stale=new URL(verifyUrl).searchParams.get('token');assert.ok(stale)
 const resend=await post('/auth/resend-verification',{email});assert.equal(resend.response.status,200)
 const missing=await post('/auth/resend-verification',{email:`missing-${randomUUID()}@example.test`});assert.equal(missing.response.status,200);assert.deepEqual(missing.body,resend.body)
 const token=new URL(verifyUrl).searchParams.get('token');assert.ok(token);assert.notEqual(token,stale)
 assert.equal((await post('/auth/verify-email',{token:stale,newPassword:password})).response.status,400)
 assert.equal((await post('/auth/verify-email',{token,newPassword:password})).response.status,200)
 assert.equal((await post('/auth/login',{email,password:attackerPassword})).response.status,401)
 assert.equal((await post('/auth/verify-email',{token,newPassword:password})).response.status,400)
 const login=await post('/auth/login',{email,password});assert.equal(login.response.status,200);assert.ok(login.body.refreshToken)
 assert.equal((await fetch(base+'/users/me',{headers:{authorization:`Bearer ${login.body.token}`}})).status,200)
 const headers={authorization:`Bearer ${login.body.token}`,'content-type':'application/json'}
 const proposedEmail=`other-${randomUUID()}@example.test`
 assert.equal((await fetch(base+'/users/me/email',{method:'PATCH',headers,body:JSON.stringify({email:proposedEmail,password})})).status,404)
 assert.equal((await fetch(base+'/users/me/email',{method:'PATCH',headers:{'content-type':'application/json'},body:JSON.stringify({email:proposedEmail})})).status,404)
 assert.equal((await fetch(base+'/users/me',{method:'PATCH',headers,body:JSON.stringify({email:proposedEmail,firstName:'Test'})})).status,200)
 const unchanged=await prisma.user.findUniqueOrThrow({where:{id:userId}});assert.equal(unchanged.email,email);assert.equal(unchanged.emailVerified,true)
 const refresh=await post('/auth/refresh',{refreshToken:login.body.refreshToken});assert.equal(refresh.response.status,200)
 assert.equal((await post('/auth/logout',{refreshToken:refresh.body.refreshToken})).response.status,204)
 assert.equal((await post('/auth/refresh',{refreshToken:refresh.body.refreshToken})).response.status,401)
 assert.equal((await post('/auth/forgot-password',{email})).response.status,200);assert.ok(resetUrl)
 const resetToken=new URL(resetUrl).searchParams.get('token');assert.ok(resetToken)
 assert.equal((await post('/auth/reset-password',{token:resetToken,newPassword:'AnotherPass2!'})).response.status,200)
 assert.equal((await post('/auth/reset-password',{token:resetToken,newPassword:'AnotherPass2!'})).response.status,400)
 assert.equal((await post('/auth/login',{email,password:'AnotherPass2!'})).response.status,200)
})

it('an unverified customer can recover only after proving email ownership',async()=>{
 const pendingEmail=`pending-${randomUUID()}@example.test`
 let id=0
 try {
  verifyUrl='';resetUrl=''
  assert.equal((await post('/auth/signup',{email:pendingEmail,password:'InitialPass1!'})).response.status,202)
  id=(await prisma.user.findUniqueOrThrow({where:{email:pendingEmail}})).id
  assert.equal((await post('/auth/forgot-password',{email:pendingEmail})).response.status,200)
  const resetToken=new URL(resetUrl).searchParams.get('token');assert.ok(resetToken)
  assert.equal((await post('/auth/reset-password',{token:resetToken,newPassword:'ResetPass1!'})).response.status,200)
  assert.equal((await post('/auth/login',{email:pendingEmail,password:'ResetPass1!'})).response.status,401)
  assert.equal((await post('/auth/resend-verification',{email:pendingEmail})).response.status,200)
  const verificationToken=new URL(verifyUrl).searchParams.get('token');assert.ok(verificationToken)
  assert.equal((await post('/auth/verify-email',{token:verificationToken,newPassword:'VerifiedPass1!'})).response.status,200)
  assert.equal((await post('/auth/login',{email:pendingEmail,password:'VerifiedPass1!'})).response.status,200)
 } finally { if(id) await prisma.user.deleteMany({where:{id}}) }
})
