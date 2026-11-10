// Local acceptance server only. Reuses the controlled daemon fixture; never starts a runner.
import { createServer } from 'node:http';
import { handleDaemonRoute, mockDaemon } from './support/mock-daemon';
import { createBaseState, createChatProvider } from './support/mock-state';
import { installNormalConversationFixture } from './support/normal-conversation-fixture';
const state=createBaseState({approvalStatus:'expired'});state.providers=[createChatProvider({id:'background-provider',lastCheck:{ok:true,code:'ready',message:'Controlled background fixture',checkedAt:'2026-10-19T00:00:00Z'}})];state.workspaceSettings.defaultProviderPresetId=state.providers[0].id;state.approvals=[];installNormalConversationFixture(state);
const server=createServer(async(req,res)=>{
 res.setHeader('Access-Control-Allow-Origin','http://127.0.0.1:4190');res.setHeader('Access-Control-Allow-Headers','content-type');res.setHeader('Access-Control-Allow-Methods','GET,POST,PUT,PATCH,DELETE,OPTIONS');
 if(req.method==='OPTIONS'){res.writeHead(204);res.end();return}
 const url='http://127.0.0.1:17892'+req.url;let body='';for await(const chunk of req)body+=chunk;
 if(new URL(url).pathname==='/runtime/conversation-execution'){res.setHeader('content-type','application/json');res.end(JSON.stringify({cwd:new URL(url).searchParams.get('cwd')??'',status:'not_selected',defaultRunnerId:'pi'}));return}
 try {await handleDaemonRoute({request:()=>({url:()=>url,method:()=>req.method,postDataJSON:()=>JSON.parse(body),postData:()=>body,headers:()=>req.headers}),fulfill:async({json,body,status=200,contentType,headers={}}:any)=>{res.writeHead(status,{'content-type':contentType??(json?'application/json':'text/plain'),...headers});res.end(json?JSON.stringify(json):body??'')},abort:async()=>res.destroy()} as any,state,{})}catch{res.writeHead(500,{'content-type':'application/json'});res.end(JSON.stringify({error:'fixture_failed'}))}
});
server.listen(17892,'127.0.0.1',()=>process.stdout.write('controlled background fixture http://127.0.0.1:17892\n'));
