export function fixture(provider, base64) {
  const g = provider === 'Gemini';
  const composer = g ? '<rich-textarea><div id="composer" class="ql-editor" contenteditable="true" role="textbox"></div></rich-textarea>' : '<textarea id="prompt-textarea"></textarea>';
  const script = `
    const provider=${JSON.stringify(provider)}, image=${JSON.stringify(`data:image/png;base64,${base64}`)};
    const composer=document.querySelector('textarea,[contenteditable]'), send=document.querySelector('#send'), input=document.querySelector('input[type=file]'), attachments=document.querySelector('#attachments');
    window.fixture={submissions:[], block:false, failUpload:false, failSubmit:false};
    function text(){return composer.tagName==='TEXTAREA'?composer.value:composer.innerText;}
    function refresh(){send.disabled=!text().trim()&&!attachments.children.length;}
    composer.addEventListener('input',refresh);
    input.addEventListener('change',()=>{
      if(window.fixture.failUpload){const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent='File upload failed: attachment limit';document.body.append(alert);return;}
      const progress=document.createElement('div');progress.setAttribute('role','progressbar');attachments.append(progress);
      setTimeout(()=>{progress.remove(); for(const file of input.files){ const b=document.createElement('button');b.type='button';b.setAttribute('aria-label','Remove file');b.textContent=file.name;b.onclick=()=>{b.remove();refresh();};attachments.append(b); } refresh();},400);
    });
    send.addEventListener('click',async()=>{
      if(send.disabled||window.fixture.block)return;
      const files=await Promise.all([...input.files].map(async f=>({name:f.name,type:f.type,bytes:[...new Uint8Array(await f.arrayBuffer())]})));
      window.fixture.submissions.push({text:text(),files});
      const turn=document.createElement(provider==='Gemini'?'user-query':'article');
      if(provider!=='Gemini')turn.setAttribute('data-message-author-role','user');
      const p=document.createElement('p');p.textContent=text();turn.append(p);
      for(const file of files){const img=document.createElement('img');img.src=image;turn.append(img);}
      document.querySelector('#turns').append(turn);
      if(composer.tagName==='TEXTAREA')composer.value='';else composer.innerText='';
      input.value='';attachments.replaceChildren();refresh();
      setTimeout(()=>{
        if(window.fixture.failSubmit){const error=document.createElement('div');error.setAttribute('role','alert');error.textContent='Something went wrong: message submission failed';document.body.append(error);return;}
        const response=document.createElement(provider==='Gemini'?'model-response':'article');
        if(provider!=='Gemini')response.setAttribute('data-message-author-role','assistant');
        const markdown=document.createElement('div');markdown.className='markdown';markdown.textContent='Fixture response acknowledges the message.';response.append(markdown);document.querySelector('#turns').append(response);
      },300);
    });`;
  return `<!doctype html><html><body><h1>${provider} integration fixture — no external requests</h1><div id="turns"></div><form onsubmit="return false">${composer}<input type="file" multiple accept="image/*"><div id="attachments"></div><button type="button" id="send" data-testid="send-button" data-test-id="send-button" aria-label="Send message" disabled>Send</button></form><script>${script}</script></body></html>`;
}
