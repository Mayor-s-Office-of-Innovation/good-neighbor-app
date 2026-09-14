var e=Object.defineProperty,t=(t,n)=>{let r={};for(var i in t)e(r,i,{get:t[i],enumerable:!0});return n||e(r,Symbol.toStringTag,{value:`Module`}),r},n=t({Default:()=>l,Disabled:()=>d,Link:()=>f,Loading:()=>p,Small:()=>u,default:()=>r}),r={title:`Foundations/Buttons`,parameters:{renderer:`html`}},i=()=>`
  <div class="story-row">
    <button class="btn-ink" type="button">Primary action</button>
    <button class="btn-outline" type="button">Secondary</button>
    <button class="btn-blue" type="button">Filed 311 ticket</button>
  </div>`,a=()=>`
  <div class="story-row">
    <button class="btn-ink btn-ink--sm" type="button">Primary</button>
    <button class="btn-outline btn-outline--sm" type="button">Secondary</button>
    <button class="btn-blue btn-blue--sm" type="button">Escalation</button>
  </div>`,o=()=>`
  <div class="story-row">
    <button class="btn-ink" type="button" disabled>Disabled primary</button>
    <button class="btn-outline" type="button" disabled>Disabled secondary</button>
  </div>`,s=()=>`
  <div class="story-row">
    <button class="login__link" type="button">Link-styled button (.login__link)</button>
  </div>`,c=()=>`
  <div class="story-stack">
    <button class="btn-ink" id="sl-load-demo" type="button">
      <span data-loading-label>Save my place</span>
      <wa-spinner style="display:none" id="sl-load-spinner"></wa-spinner>
    </button>
    <small style="color:var(--text-secondary)">Click to see the busy state — width must not change.</small>
  </div>
  <script type="module">
    const btn = document.getElementById("sl-load-demo");
    const spinner = document.getElementById("sl-load-spinner");
    btn?.addEventListener("click", () => {
      btn.style.setProperty("--btn-loading-min-width", btn.offsetWidth + "px");
      btn.setAttribute("data-loading", "");
      btn.setAttribute("aria-busy", "true");
      btn.disabled = true;
      spinner.style.display = "inline-block";
      setTimeout(() => {
        btn.removeAttribute("data-loading");
        btn.removeAttribute("aria-busy");
        btn.disabled = false;
        spinner.style.display = "none";
      }, 1800);
    }, { once: false });
  <\/script>`,l={name:`Pills`,render:()=>i()},u={render:()=>a()},d={render:()=>o()},f={render:()=>s()},p={render:()=>c(),source:()=>`// Loading pattern (app.css button[data-loading]):
// btn.style.setProperty("--btn-loading-min-width", btn.offsetWidth + "px");
// btn.setAttribute("data-loading", "");
// btn.setAttribute("aria-busy", "true");
// btn.disabled = true;
// // ... await work, then remove all three`},m=t({Default:()=>_,default:()=>h}),h={title:`Web Awesome/Icons`,parameters:{renderer:`html`},source:`<wa-icon name="camera"></wa-icon>`},g=`arrow-down.camera.chevron-left.chevron-right.circle-check.circle-plus.circle-stop.circle-xmark.comment.ellipsis.file-lines.flag.gear.image.list-check.location-dot.microphone.moon.pen.pen-clip.repeat.rotate.sparkles.spinner.star.sun.trash.triangle-exclamation.xmark`.split(`.`),_={name:`Self-hosted set`,render:()=>`
    <p class="story-label">Resolved from /public/icons — no Font Awesome CDN</p>
    <div class="story-row" style="max-width:560px">
      ${g.map(e=>`<div class="story-stack" style="gap:0.3rem">
        <wa-icon name="${e}" style="font-size:1.25rem"></wa-icon>
        <code style="font-size:0.62rem; color:var(--text-faint)">${e}</code>
      </div>`).join(``)}
    </div>`,source:()=>`<!-- Icons resolve locally via registerIconLibrary("default", ...)
     in main.js; add a new icon by dropping its SVG into frontend/public/icons/ -->
<wa-icon name="camera"></wa-icon>`},v=t({Default:()=>b,default:()=>y}),y={title:`Foundations/Status pills`,parameters:{renderer:`html`},source:`<span class="pill pill--route">En route</span>`},b={name:`All variants`,render:()=>`
    <div class="story-row">
      <span class="pill pill--route">En route</span>
      <span class="pill pill--confirm">Confirm</span>
      <span class="pill pill--pending">Pending</span>
      <span class="pill pill--sev">Sev 2</span>
    </div>`},x=globalThis,ee=x.ShadowRoot&&(x.ShadyCSS===void 0||x.ShadyCSS.nativeShadow)&&`adoptedStyleSheets`in Document.prototype&&`replace`in CSSStyleSheet.prototype,S=Symbol(),te=new WeakMap,C=class{constructor(e,t,n){if(this._$cssResult$=!0,n!==S)throw Error("CSSResult is not constructable. Use `unsafeCSS` or `css` instead.");this.cssText=e,this._strings=t}get styleSheet(){let e=this._styleSheet,t=this._strings;if(ee&&e===void 0){let n=t!==void 0&&t.length===1;n&&(e=te.get(t)),e===void 0&&((this._styleSheet=e=new CSSStyleSheet).replaceSync(this.cssText),n&&te.set(t,e))}return e}toString(){return this.cssText}},ne=e=>{if(e._$cssResult$===!0)return e.cssText;if(typeof e==`number`)return e;throw Error(`Value passed to 'css' function must be a 'css' function result: ${e}. Use 'unsafeCSS' to pass non-literal values, but take care to ensure page security.`)},re=e=>new C(typeof e==`string`?e:String(e),void 0,S),w=(e,...t)=>new C(e.length===1?e[0]:t.reduce((t,n,r)=>t+ne(n)+e[r+1],e[0]),e,S),ie=(e,t)=>{if(ee)e.adoptedStyleSheets=t.map(e=>e instanceof CSSStyleSheet?e:e.styleSheet);else for(let n of t){let t=document.createElement(`style`),r=x.litNonce;r!==void 0&&t.setAttribute(`nonce`,r),t.textContent=n.cssText,e.appendChild(t)}},ae=e=>{let t=``;for(let n of e.cssRules)t+=n.cssText;return re(t)},oe=ee?e=>e:e=>e instanceof CSSStyleSheet?ae(e):e,{is:se,defineProperty:ce,getOwnPropertyDescriptor:le,getOwnPropertyNames:ue,getOwnPropertySymbols:de,getPrototypeOf:fe}=Object,T=globalThis,E,pe=T.trustedTypes,me=pe?pe.emptyScript:``,he=T.reactiveElementPolyfillSupportDevMode;T.litIssuedWarnings??=new Set,E=(e,t)=>{t+=` See https://lit.dev/msg/${e} for more information.`,!T.litIssuedWarnings.has(t)&&!T.litIssuedWarnings.has(e)&&(console.warn(t),T.litIssuedWarnings.add(t))},queueMicrotask(()=>{E(`dev-mode`,`Lit is in dev mode. Not recommended for production!`),T.ShadyDOM?.inUse&&he===void 0&&E(`polyfill-support-missing`,"Shadow DOM is being polyfilled via `ShadyDOM` but the `polyfill-support` module has not been loaded.")});var ge=e=>{T.emitLitDebugLogEvents&&T.dispatchEvent(new CustomEvent(`lit-debug`,{detail:e}))},_e=(e,t)=>e,ve={toAttribute(e,t){switch(t){case Boolean:e=e?me:null;break;case Object:case Array:e=e==null?e:JSON.stringify(e)}return e},fromAttribute(e,t){let n=e;switch(t){case Boolean:n=e!==null;break;case Number:n=e===null?null:Number(e);break;case Object:case Array:try{n=JSON.parse(e)}catch{n=null}}return n}},ye=(e,t)=>!se(e,t),be={attribute:!0,type:String,converter:ve,reflect:!1,useDefault:!1,hasChanged:ye};Symbol.metadata??=Symbol(`metadata`),T.litPropertyMetadata??=new WeakMap;var D=class extends HTMLElement{static addInitializer(e){this.__prepare(),(this._initializers??=[]).push(e)}static get observedAttributes(){return this.finalize(),this.__attributeToPropertyMap&&[...this.__attributeToPropertyMap.keys()]}static createProperty(e,t=be){if(t.state&&(t.attribute=!1),this.__prepare(),this.prototype.hasOwnProperty(e)&&(t=Object.create(t),t.wrapped=!0),this.elementProperties.set(e,t),!t.noAccessor){let n=Symbol.for(`${String(e)} (@property() cache)`),r=this.getPropertyDescriptor(e,n,t);r!==void 0&&ce(this.prototype,e,r)}}static getPropertyDescriptor(e,t,n){let{get:r,set:i}=le(this.prototype,e)??{get(){return this[t]},set(e){this[t]=e}};if(r==null){if(`value`in(le(this.prototype,e)??{}))throw Error(`Field ${JSON.stringify(String(e))} on ${this.name} was declared as a reactive property but it's actually declared as a value on the prototype. Usually this is due to using @property or @state on a method.`);E(`reactive-property-without-getter`,`Field ${JSON.stringify(String(e))} on ${this.name} was declared as a reactive property but it does not have a getter. This will be an error in a future version of Lit.`)}return{get:r,set(t){let a=r?.call(this);i?.call(this,t),this.requestUpdate(e,a,n)},configurable:!0,enumerable:!0}}static getPropertyOptions(e){return this.elementProperties.get(e)??be}static __prepare(){if(this.hasOwnProperty(_e(`elementProperties`,this)))return;let e=fe(this);e.finalize(),e._initializers!==void 0&&(this._initializers=[...e._initializers]),this.elementProperties=new Map(e.elementProperties)}static finalize(){if(this.hasOwnProperty(_e(`finalized`,this)))return;if(this.finalized=!0,this.__prepare(),this.hasOwnProperty(_e(`properties`,this))){let e=this.properties,t=[...ue(e),...de(e)];for(let n of t)this.createProperty(n,e[n])}let e=this[Symbol.metadata];if(e!==null){let t=litPropertyMetadata.get(e);if(t!==void 0)for(let[e,n]of t)this.elementProperties.set(e,n)}this.__attributeToPropertyMap=new Map;for(let[e,t]of this.elementProperties){let n=this.__attributeNameForProperty(e,t);n!==void 0&&this.__attributeToPropertyMap.set(n,e)}this.elementStyles=this.finalizeStyles(this.styles),this.hasOwnProperty(`createProperty`)&&E(`no-override-create-property`,`Overriding ReactiveElement.createProperty() is deprecated. The override will not be called with standard decorators`),this.hasOwnProperty(`getPropertyDescriptor`)&&E(`no-override-get-property-descriptor`,`Overriding ReactiveElement.getPropertyDescriptor() is deprecated. The override will not be called with standard decorators`)}static finalizeStyles(e){let t=[];if(Array.isArray(e)){let n=new Set(e.flat(1/0).reverse());for(let e of n)t.unshift(oe(e))}else e!==void 0&&t.push(oe(e));return t}static __attributeNameForProperty(e,t){let n=t.attribute;return n===!1?void 0:typeof n==`string`?n:typeof e==`string`?e.toLowerCase():void 0}constructor(){super(),this.__instanceProperties=void 0,this.isUpdatePending=!1,this.hasUpdated=!1,this.__reflectingProperty=null,this.__initialize()}__initialize(){this.__updatePromise=new Promise(e=>this.enableUpdating=e),this._$changedProperties=new Map,this.__saveInstanceProperties(),this.requestUpdate(),this.constructor._initializers?.forEach(e=>e(this))}addController(e){(this.__controllers??=new Set).add(e),this.renderRoot!==void 0&&this.isConnected&&e.hostConnected?.()}removeController(e){this.__controllers?.delete(e)}__saveInstanceProperties(){let e=new Map,t=this.constructor.elementProperties;for(let n of t.keys())this.hasOwnProperty(n)&&(e.set(n,this[n]),delete this[n]);e.size>0&&(this.__instanceProperties=e)}createRenderRoot(){let e=this.shadowRoot??this.attachShadow(this.constructor.shadowRootOptions);return ie(e,this.constructor.elementStyles),e}connectedCallback(){this.renderRoot??=this.createRenderRoot(),this.enableUpdating(!0),this.__controllers?.forEach(e=>e.hostConnected?.())}enableUpdating(e){}disconnectedCallback(){this.__controllers?.forEach(e=>e.hostDisconnected?.())}attributeChangedCallback(e,t,n){this._$attributeToProperty(e,n)}__propertyToAttribute(e,t){let n=this.constructor.elementProperties.get(e),r=this.constructor.__attributeNameForProperty(e,n);if(r!==void 0&&n.reflect===!0){let i=(n.converter?.toAttribute===void 0?ve:n.converter).toAttribute(t,n.type);this.constructor.enabledWarnings.includes(`migration`)&&i===void 0&&E(`undefined-attribute-value`,`The attribute value for the ${e} property is undefined on element ${this.localName}. The attribute will be removed, but in the previous version of \`ReactiveElement\`, the attribute would not have changed.`),this.__reflectingProperty=e,i==null?this.removeAttribute(r):this.setAttribute(r,i),this.__reflectingProperty=null}}_$attributeToProperty(e,t){let n=this.constructor,r=n.__attributeToPropertyMap.get(e);if(r!==void 0&&this.__reflectingProperty!==r){let e=n.getPropertyOptions(r),i=typeof e.converter==`function`?{fromAttribute:e.converter}:e.converter?.fromAttribute===void 0?ve:e.converter;this.__reflectingProperty=r;let a=i.fromAttribute(t,e.type);this[r]=a??this.__defaultValues?.get(r)??a,this.__reflectingProperty=null}}requestUpdate(e,t,n,r=!1,i){if(e!==void 0){e instanceof Event&&E(``,`The requestUpdate() method was called with an Event as the property name. This is probably a mistake caused by binding this.requestUpdate as an event listener. Instead bind a function that will call it with no arguments: () => this.requestUpdate()`);let a=this.constructor;if(r===!1&&(i=this[e]),n??=a.getPropertyOptions(e),(n.hasChanged??ye)(i,t)||n.useDefault&&n.reflect&&i===this.__defaultValues?.get(e)&&!this.hasAttribute(a.__attributeNameForProperty(e,n)))this._$changeProperty(e,t,n);else return}this.isUpdatePending===!1&&(this.__updatePromise=this.__enqueueUpdate())}_$changeProperty(e,t,{useDefault:n,reflect:r,wrapped:i},a){n&&!(this.__defaultValues??=new Map).has(e)&&(this.__defaultValues.set(e,a??t??this[e]),i!==!0||a!==void 0)||(this._$changedProperties.has(e)||(!this.hasUpdated&&!n&&(t=void 0),this._$changedProperties.set(e,t)),r===!0&&this.__reflectingProperty!==e&&(this.__reflectingProperties??=new Set).add(e))}async __enqueueUpdate(){this.isUpdatePending=!0;try{await this.__updatePromise}catch(e){Promise.reject(e)}let e=this.scheduleUpdate();return e!=null&&await e,!this.isUpdatePending}scheduleUpdate(){let e=this.performUpdate();return this.constructor.enabledWarnings.includes(`async-perform-update`)&&typeof e?.then==`function`&&E(`async-perform-update`,`Element ${this.localName} returned a Promise from performUpdate(). This behavior is deprecated and will be removed in a future version of ReactiveElement.`),e}performUpdate(){if(!this.isUpdatePending)return;if(ge?.({kind:`update`}),!this.hasUpdated){this.renderRoot??=this.createRenderRoot();{let e=[...this.constructor.elementProperties.keys()].filter(e=>this.hasOwnProperty(e)&&e in fe(this));if(e.length)throw Error(`The following properties on element ${this.localName} will not trigger updates as expected because they are set using class fields: ${e.join(`, `)}. Native class fields and some compiled output will overwrite accessors used for detecting changes. See https://lit.dev/msg/class-field-shadowing for more information.`)}if(this.__instanceProperties){for(let[e,t]of this.__instanceProperties)this[e]=t;this.__instanceProperties=void 0}let e=this.constructor.elementProperties;if(e.size>0)for(let[t,n]of e){let{wrapped:e}=n,r=this[t];e===!0&&!this._$changedProperties.has(t)&&r!==void 0&&this._$changeProperty(t,void 0,n,r)}}let e=!1,t=this._$changedProperties;try{e=this.shouldUpdate(t),e?(this.willUpdate(t),this.__controllers?.forEach(e=>e.hostUpdate?.()),this.update(t)):this.__markUpdated()}catch(t){throw e=!1,this.__markUpdated(),t}e&&this._$didUpdate(t)}willUpdate(e){}_$didUpdate(e){this.__controllers?.forEach(e=>e.hostUpdated?.()),this.hasUpdated||(this.hasUpdated=!0,this.firstUpdated(e)),this.updated(e),this.isUpdatePending&&this.constructor.enabledWarnings.includes(`change-in-update`)&&E(`change-in-update`,`Element ${this.localName} scheduled an update (generally because a property was set) after an update completed, causing a new update to be scheduled. This is inefficient and should be avoided unless the next update can only be scheduled as a side effect of the previous update.`)}__markUpdated(){this._$changedProperties=new Map,this.isUpdatePending=!1}get updateComplete(){return this.getUpdateComplete()}getUpdateComplete(){return this.__updatePromise}shouldUpdate(e){return!0}update(e){this.__reflectingProperties&&=this.__reflectingProperties.forEach(e=>this.__propertyToAttribute(e,this[e])),this.__markUpdated()}updated(e){}firstUpdated(e){}};D.elementStyles=[],D.shadowRootOptions={mode:`open`},D[_e(`elementProperties`,D)]=new Map,D[_e(`finalized`,D)]=new Map,he?.({ReactiveElement:D});{D.enabledWarnings=[`change-in-update`,`async-perform-update`];let e=function(e){e.hasOwnProperty(_e(`enabledWarnings`,e))||(e.enabledWarnings=e.enabledWarnings.slice())};D.enableWarning=function(t){e(this),this.enabledWarnings.includes(t)||this.enabledWarnings.push(t)},D.disableWarning=function(t){e(this);let n=this.enabledWarnings.indexOf(t);n>=0&&this.enabledWarnings.splice(n,1)}}(T.reactiveElementVersions??=[]).push(`2.1.2`),T.reactiveElementVersions.length>1&&queueMicrotask(()=>{E(`multiple-versions`,`Multiple versions of Lit loaded. Loading multiple versions is not recommended.`)});var O=globalThis,k=e=>{O.emitLitDebugLogEvents&&O.dispatchEvent(new CustomEvent(`lit-debug`,{detail:e}))},xe=0,Se;O.litIssuedWarnings??=new Set,Se=(e,t)=>{t+=e?` See https://lit.dev/msg/${e} for more information.`:``,!O.litIssuedWarnings.has(t)&&!O.litIssuedWarnings.has(e)&&(console.warn(t),O.litIssuedWarnings.add(t))},queueMicrotask(()=>{Se(`dev-mode`,`Lit is in dev mode. Not recommended for production!`)});var A=O.ShadyDOM?.inUse&&O.ShadyDOM?.noPatch===!0?O.ShadyDOM.wrap:e=>e,Ce=O.trustedTypes,we=Ce?Ce.createPolicy(`lit-html`,{createHTML:e=>e}):void 0,Te=e=>e,Ee=(e,t,n)=>Te,De=e=>{if(mt!==Ee)throw Error(`Attempted to overwrite existing lit-html security policy. setSanitizeDOMValueFactory should be called at most once.`);mt=e},Oe=()=>{mt=Ee},ke=(e,t,n)=>mt(e,t,n),Ae=`$lit$`,je=`lit$${Math.random().toFixed(9).slice(2)}$`,Me=`?`+je,Ne=`<${Me}>`,Pe=document,Fe=()=>Pe.createComment(``),Ie=e=>e===null||typeof e!=`object`&&typeof e!=`function`,Le=Array.isArray,Re=e=>Le(e)||typeof e?.[Symbol.iterator]==`function`,ze=`[ 	
\f\r]`,Be=`[^ 	
\f\r"'\`<>=]`,Ve=`[^\\s"'>=/]`,He=/<(?:(!--|\/[^a-zA-Z])|(\/?[a-zA-Z][^>\s]*)|(\/?$))/g,Ue=1,We=2,Ge=3,Ke=/-->/g,qe=/>/g,Je=RegExp(`>|${ze}(?:(${Ve}+)(${ze}*=${ze}*(?:${Be}|("|')|))|$)`,`g`),Ye=0,Xe=1,Ze=2,Qe=3,$e=/'/g,et=/"/g,tt=/^(?:script|style|textarea|title)$/i,nt=1,rt=2,it=3,at=1,ot=2,st=3,ct=4,lt=5,ut=6,dt=7,j=(e=>(t,...n)=>(t.some(e=>e===void 0)&&console.warn(`Some template strings are undefined.
This is probably caused by illegal octal escape sequences.`),n.some(e=>e?._$litStatic$)&&Se(``,`Static values 'literal' or 'unsafeStatic' cannot be used as values to non-static templates.
Please use the static 'html' tag function. See https://lit.dev/docs/templates/expressions/#static-expressions`),{_$litType$:e,strings:t,values:n}))(nt),M=Symbol.for(`lit-noChange`),N=Symbol.for(`lit-nothing`),ft=new WeakMap,pt=Pe.createTreeWalker(Pe,129),mt=Ee;function ht(e,t){if(!Le(e)||!e.hasOwnProperty(`raw`)){let e=`invalid template strings array`;throw e=`Internal Error: expected template strings to be an array
          with a 'raw' field. Faking a template strings array by
          calling html or svg like an ordinary function is effectively
          the same as calling unsafeHtml and can lead to major security
          issues, e.g. opening your code up to XSS attacks.
          If you're using the html or svg tagged template functions normally
          and still seeing this error, please file a bug at
          https://github.com/lit/lit/issues/new?template=bug_report.md
          and include information about your build tooling, if any.`.replace(/\n */g,`
`),Error(e)}return we===void 0?t:we.createHTML(t)}var gt=(e,t)=>{let n=e.length-1,r=[],i=t===rt?`<svg>`:t===it?`<math>`:``,a,o=He;for(let t=0;t<n;t++){let n=e[t],s=-1,c,l=0,u;for(;l<n.length&&(o.lastIndex=l,u=o.exec(n),u!==null);)if(l=o.lastIndex,o===He){if(u[Ue]===`!--`)o=Ke;else if(u[Ue]!==void 0)o=qe;else if(u[We]!==void 0)tt.test(u[We])&&(a=RegExp(`</${u[We]}`,`g`)),o=Je;else if(u[Ge]!==void 0)throw Error(`Bindings in tag names are not supported. Please use static templates instead. See https://lit.dev/docs/templates/expressions/#static-expressions`)}else o===Je?u[Ye]===`>`?(o=a??He,s=-1):u[Xe]===void 0?s=-2:(s=o.lastIndex-u[Ze].length,c=u[Xe],o=u[Qe]===void 0?Je:u[Qe]===`"`?et:$e):o===et||o===$e?o=Je:o===Ke||o===qe?o=He:(o=Je,a=void 0);console.assert(s===-1||o===Je||o===$e||o===et,`unexpected parse state B`);let d=o===Je&&e[t+1].startsWith(`/>`)?` `:``;i+=o===He?n+Ne:s>=0?(r.push(c),n.slice(0,s)+Ae+n.slice(s)+je+d):n+je+(s===-2?t:d)}return[ht(e,i+(e[n]||`<?>`)+(t===rt?`</svg>`:t===it?`</math>`:``)),r]},_t=class e{constructor({strings:t,_$litType$:n},r){this.parts=[];let i,a=0,o=0,s=t.length-1,c=this.parts,[l,u]=gt(t,n);if(this.el=e.createElement(l,r),pt.currentNode=this.el.content,n===rt||n===it){let e=this.el.content.firstChild;e.replaceWith(...e.childNodes)}for(;(i=pt.nextNode())!==null&&c.length<s;){if(i.nodeType===1){{let e=i.localName;if(/^(?:textarea|template)$/i.test(e)&&i.innerHTML.includes(je)){let t=`Expressions are not supported inside \`${e}\` elements. See https://lit.dev/msg/expression-in-${e} for more information.`;if(e===`template`)throw Error(t);Se(``,t)}}if(i.hasAttributes())for(let e of i.getAttributeNames())if(e.endsWith(Ae)){let t=u[o++],n=i.getAttribute(e).split(je),r=/([.?@])?(.*)/.exec(t);c.push({type:at,index:a,name:r[2],strings:n,ctor:r[1]===`.`?St:r[1]===`?`?Ct:r[1]===`@`?wt:xt}),i.removeAttribute(e)}else e.startsWith(je)&&(c.push({type:ut,index:a}),i.removeAttribute(e));if(tt.test(i.tagName)){let e=i.textContent.split(je),t=e.length-1;if(t>0){i.textContent=Ce?Ce.emptyScript:``;for(let n=0;n<t;n++)i.append(e[n],Fe()),pt.nextNode(),c.push({type:ot,index:++a});i.append(e[t],Fe())}}}else if(i.nodeType===8){if(i.data===Me)c.push({type:ot,index:a});else{let e=-1;for(;(e=i.data.indexOf(je,e+1))!==-1;)c.push({type:dt,index:a}),e+=je.length-1}}a++}if(u.length!==o)throw Error('Detected duplicate attribute bindings. This occurs if your template has duplicate attributes on an element tag. For example "<input ?disabled=${true} ?disabled=${false}>" contains a duplicate "disabled" attribute. The error was detected in the following template: \n`'+t.join("${...}")+"`");k&&k({kind:`template prep`,template:this,clonableTemplate:this.el,parts:this.parts,strings:t})}static createElement(e,t){let n=Pe.createElement(`template`);return n.innerHTML=e,n}};function vt(e,t,n=e,r){if(t===M)return t;let i=r===void 0?n.__directive:n.__directives?.[r],a=Ie(t)?void 0:t._$litDirective$;return i?.constructor!==a&&(i?._$notifyDirectiveConnectionChanged?.(!1),a===void 0?i=void 0:(i=new a(e),i._$initialize(e,n,r)),r===void 0?n.__directive=i:(n.__directives??=[])[r]=i),i!==void 0&&(t=vt(e,i._$resolve(e,t.values),i,r)),t}var yt=class{constructor(e,t){this._$parts=[],this._$disconnectableChildren=void 0,this._$template=e,this._$parent=t}get parentNode(){return this._$parent.parentNode}get _$isConnected(){return this._$parent._$isConnected}_clone(e){let{el:{content:t},parts:n}=this._$template,r=(e?.creationScope??Pe).importNode(t,!0);pt.currentNode=r;let i=pt.nextNode(),a=0,o=0,s=n[0];for(;s!==void 0;){if(a===s.index){let t;s.type===ot?t=new bt(i,i.nextSibling,this,e):s.type===at?t=new s.ctor(i,s.name,s.strings,this,e):s.type===ut&&(t=new Tt(i,this,e)),this._$parts.push(t),s=n[++o]}a!==s?.index&&(i=pt.nextNode(),a++)}return pt.currentNode=Pe,r}_update(e){let t=0;for(let n of this._$parts)n!==void 0&&(k&&k({kind:`set part`,part:n,value:e[t],valueIndex:t,values:e,templateInstance:this}),n.strings===void 0?n._$setValue(e[t]):(n._$setValue(e,n,t),t+=n.strings.length-2)),t++}},bt=class e{get _$isConnected(){return this._$parent?._$isConnected??this.__isConnected}constructor(e,t,n,r){this.type=ot,this._$committedValue=N,this._$disconnectableChildren=void 0,this._$startNode=e,this._$endNode=t,this._$parent=n,this.options=r,this.__isConnected=r?.isConnected??!0,this._textSanitizer=void 0}get parentNode(){let e=A(this._$startNode).parentNode,t=this._$parent;return t!==void 0&&e?.nodeType===11&&(e=t.parentNode),e}get startNode(){return this._$startNode}get endNode(){return this._$endNode}_$setValue(e,t=this){if(this.parentNode===null)throw Error("This `ChildPart` has no `parentNode` and therefore cannot accept a value. This likely means the element containing the part was manipulated in an unsupported way outside of Lit's control such that the part's marker nodes were ejected from DOM. For example, setting the element's `innerHTML` or `textContent` can do this.");if(e=vt(this,e,t),Ie(e))e===N||e==null||e===``?(this._$committedValue!==N&&(k&&k({kind:`commit nothing to child`,start:this._$startNode,end:this._$endNode,parent:this._$parent,options:this.options}),this._$clear()),this._$committedValue=N):e!==this._$committedValue&&e!==M&&this._commitText(e);else if(e._$litType$!==void 0)this._commitTemplateResult(e);else if(e.nodeType!==void 0){if(this.options?.host===e){this._commitText("[probable mistake: rendered a template's host in itself (commonly caused by writing ${this} in a template]"),console.warn(`Attempted to render the template host`,e,`inside itself. This is almost always a mistake, and in dev mode `,`we render some warning text. In production however, we'll `,`render it, which will usually result in an error, and sometimes `,`in the element disappearing from the DOM.`);return}this._commitNode(e)}else Re(e)?this._commitIterable(e):this._commitText(e)}_insert(e){return A(A(this._$startNode).parentNode).insertBefore(e,this._$endNode)}_commitNode(e){if(this._$committedValue!==e){if(this._$clear(),mt!==Ee){let e=this._$startNode.parentNode?.nodeName;if(e===`STYLE`||e===`SCRIPT`){let t=`Forbidden`;throw t=e===`STYLE`?"Lit does not support binding inside style nodes. This is a security risk, as style injection attacks can exfiltrate data and spoof UIs. Consider instead using css`...` literals to compose styles, and do dynamic styling with css custom properties, ::parts, <slot>s, and by mutating the DOM rather than stylesheets.":`Lit does not support binding inside script nodes. This is a security risk, as it could allow arbitrary code execution.`,Error(t)}}k&&k({kind:`commit node`,start:this._$startNode,parent:this._$parent,value:e,options:this.options}),this._$committedValue=this._insert(e)}}_commitText(e){if(this._$committedValue!==N&&Ie(this._$committedValue)){let t=A(this._$startNode).nextSibling;this._textSanitizer===void 0&&(this._textSanitizer=ke(t,`data`,`property`)),e=this._textSanitizer(e),k&&k({kind:`commit text`,node:t,value:e,options:this.options}),t.data=e}else{let t=Pe.createTextNode(``);this._commitNode(t),this._textSanitizer===void 0&&(this._textSanitizer=ke(t,`data`,`property`)),e=this._textSanitizer(e),k&&k({kind:`commit text`,node:t,value:e,options:this.options}),t.data=e}this._$committedValue=e}_commitTemplateResult(e){let{values:t,_$litType$:n}=e,r=typeof n==`number`?this._$getTemplate(e):(n.el===void 0&&(n.el=_t.createElement(ht(n.h,n.h[0]),this.options)),n);if(this._$committedValue?._$template===r)k&&k({kind:`template updating`,template:r,instance:this._$committedValue,parts:this._$committedValue._$parts,options:this.options,values:t}),this._$committedValue._update(t);else{let e=new yt(r,this),n=e._clone(this.options);k&&k({kind:`template instantiated`,template:r,instance:e,parts:e._$parts,options:this.options,fragment:n,values:t}),e._update(t),k&&k({kind:`template instantiated and updated`,template:r,instance:e,parts:e._$parts,options:this.options,fragment:n,values:t}),this._commitNode(n),this._$committedValue=e}}_$getTemplate(e){let t=ft.get(e.strings);return t===void 0&&ft.set(e.strings,t=new _t(e)),t}_commitIterable(t){Le(this._$committedValue)||(this._$committedValue=[],this._$clear());let n=this._$committedValue,r=0,i;for(let a of t)r===n.length?n.push(i=new e(this._insert(Fe()),this._insert(Fe()),this,this.options)):i=n[r],i._$setValue(a),r++;r<n.length&&(this._$clear(i&&A(i._$endNode).nextSibling,r),n.length=r)}_$clear(e=A(this._$startNode).nextSibling,t){for(this._$notifyConnectionChanged?.(!1,!0,t);e!==this._$endNode;){let t=A(e).nextSibling;A(e).remove(),e=t}}setConnected(e){if(this._$parent===void 0)this.__isConnected=e,this._$notifyConnectionChanged?.(e);else throw Error(`part.setConnected() may only be called on a RootPart returned from render().`)}},xt=class{get tagName(){return this.element.tagName}get _$isConnected(){return this._$parent._$isConnected}constructor(e,t,n,r,i){this.type=at,this._$committedValue=N,this._$disconnectableChildren=void 0,this.element=e,this.name=t,this._$parent=r,this.options=i,n.length>2||n[0]!==``||n[1]!==``?(this._$committedValue=Array(n.length-1).fill(new String),this.strings=n):this._$committedValue=N,this._sanitizer=void 0}_$setValue(e,t=this,n,r){let i=this.strings,a=!1;if(i===void 0)e=vt(this,e,t,0),a=!Ie(e)||e!==this._$committedValue&&e!==M,a&&(this._$committedValue=e);else{let r=e;e=i[0];let o,s;for(o=0;o<i.length-1;o++)s=vt(this,r[n+o],t,o),s===M&&(s=this._$committedValue[o]),a||=!Ie(s)||s!==this._$committedValue[o],s===N?e=N:e!==N&&(e+=(s??``)+i[o+1]),this._$committedValue[o]=s}a&&!r&&this._commitValue(e)}_commitValue(e){e===N?A(this.element).removeAttribute(this.name):(this._sanitizer===void 0&&(this._sanitizer=mt(this.element,this.name,`attribute`)),e=this._sanitizer(e??``),k&&k({kind:`commit attribute`,element:this.element,name:this.name,value:e,options:this.options}),A(this.element).setAttribute(this.name,e??``))}},St=class extends xt{constructor(){super(...arguments),this.type=st}_commitValue(e){this._sanitizer===void 0&&(this._sanitizer=mt(this.element,this.name,`property`)),e=this._sanitizer(e),k&&k({kind:`commit property`,element:this.element,name:this.name,value:e,options:this.options}),this.element[this.name]=e===N?void 0:e}},Ct=class extends xt{constructor(){super(...arguments),this.type=ct}_commitValue(e){k&&k({kind:`commit boolean attribute`,element:this.element,name:this.name,value:!!(e&&e!==N),options:this.options}),A(this.element).toggleAttribute(this.name,!!e&&e!==N)}},wt=class extends xt{constructor(e,t,n,r,i){if(super(e,t,n,r,i),this.type=lt,this.strings!==void 0)throw Error(`A \`<${e.localName}>\` has a \`@${t}=...\` listener with invalid content. Event listeners in templates must have exactly one expression and no surrounding text.`)}_$setValue(e,t=this){if(e=vt(this,e,t,0)??N,e===M)return;let n=this._$committedValue,r=e===N&&n!==N||e.capture!==n.capture||e.once!==n.once||e.passive!==n.passive,i=e!==N&&(n===N||r);k&&k({kind:`commit event listener`,element:this.element,name:this.name,value:e,options:this.options,removeListener:r,addListener:i,oldListener:n}),r&&this.element.removeEventListener(this.name,this,n),i&&this.element.addEventListener(this.name,this,e),this._$committedValue=e}handleEvent(e){typeof this._$committedValue==`function`?this._$committedValue.call(this.options?.host??this.element,e):this._$committedValue.handleEvent(e)}},Tt=class{constructor(e,t,n){this.element=e,this.type=ut,this._$disconnectableChildren=void 0,this._$parent=t,this.options=n}get _$isConnected(){return this._$parent._$isConnected}_$setValue(e){k&&k({kind:`commit to element binding`,element:this.element,value:e,options:this.options}),vt(this,e)}},Et={_boundAttributeSuffix:Ae,_marker:je,_markerMatch:Me,_HTML_RESULT:nt,_getTemplateHtml:gt,_TemplateInstance:yt,_isIterable:Re,_resolveDirective:vt,_ChildPart:bt,_AttributePart:xt,_BooleanAttributePart:Ct,_EventPart:wt,_PropertyPart:St,_ElementPart:Tt},Dt=O.litHtmlPolyfillSupportDevMode;Dt?.(_t,bt),(O.litHtmlVersions??=[]).push(`3.3.3`),O.litHtmlVersions.length>1&&queueMicrotask(()=>{Se(`multiple-versions`,`Multiple versions of Lit loaded. Loading multiple versions is not recommended.`)});var Ot=(e,t,n)=>{if(t==null)throw TypeError(`The container to render into may not be ${t}`);let r=xe++,i=n?.renderBefore??t,a=i._$litPart$;if(k&&k({kind:`begin render`,id:r,value:e,container:t,options:n,part:a}),a===void 0){let e=n?.renderBefore??null;i._$litPart$=a=new bt(t.insertBefore(Fe(),e),e,void 0,n??{})}return a._$setValue(e),k&&k({kind:`end render`,id:r,value:e,container:t,options:n,part:a}),a};Ot.setSanitizer=De,Ot.createSanitizer=ke,Ot._testOnlyClearSanitizerFactoryDoNotCallOrElse=Oe;var kt=(e,t)=>e,At=globalThis,jt;At.litIssuedWarnings??=new Set,jt=(e,t)=>{t+=` See https://lit.dev/msg/${e} for more information.`,!At.litIssuedWarnings.has(t)&&!At.litIssuedWarnings.has(e)&&(console.warn(t),At.litIssuedWarnings.add(t))};var Mt=class extends D{constructor(){super(...arguments),this.renderOptions={host:this},this.__childPart=void 0}createRenderRoot(){let e=super.createRenderRoot();return this.renderOptions.renderBefore??=e.firstChild,e}update(e){let t=this.render();this.hasUpdated||(this.renderOptions.isConnected=this.isConnected),super.update(e),this.__childPart=Ot(t,this.renderRoot,this.renderOptions)}connectedCallback(){super.connectedCallback(),this.__childPart?.setConnected(!0)}disconnectedCallback(){super.disconnectedCallback(),this.__childPart?.setConnected(!1)}render(){return M}};Mt._$litElement$=!0,Mt[kt(`finalized`,Mt)]=!0,At.litElementHydrateSupport?.({LitElement:Mt});var Nt=At.litElementPolyfillSupportDevMode;Nt?.({LitElement:Mt}),(At.litElementVersions??=[]).push(`4.2.2`),At.litElementVersions.length>1&&queueMicrotask(()=>{jt(`multiple-versions`,`Multiple versions of Lit loaded. Loading multiple versions is not recommended.`)});var Pt=w`
  :where(:root),
  .wa-neutral,
  :host([variant='neutral']) {
    --wa-color-fill-loud: var(--wa-color-neutral-fill-loud);
    --wa-color-fill-normal: var(--wa-color-neutral-fill-normal);
    --wa-color-fill-quiet: var(--wa-color-neutral-fill-quiet);
    --wa-color-border-loud: var(--wa-color-neutral-border-loud);
    --wa-color-border-normal: var(--wa-color-neutral-border-normal);
    --wa-color-border-quiet: var(--wa-color-neutral-border-quiet);
    --wa-color-on-loud: var(--wa-color-neutral-on-loud);
    --wa-color-on-normal: var(--wa-color-neutral-on-normal);
    --wa-color-on-quiet: var(--wa-color-neutral-on-quiet);
  }

  .wa-brand,
  :host([variant='brand']) {
    --wa-color-fill-loud: var(--wa-color-brand-fill-loud);
    --wa-color-fill-normal: var(--wa-color-brand-fill-normal);
    --wa-color-fill-quiet: var(--wa-color-brand-fill-quiet);
    --wa-color-border-loud: var(--wa-color-brand-border-loud);
    --wa-color-border-normal: var(--wa-color-brand-border-normal);
    --wa-color-border-quiet: var(--wa-color-brand-border-quiet);
    --wa-color-on-loud: var(--wa-color-brand-on-loud);
    --wa-color-on-normal: var(--wa-color-brand-on-normal);
    --wa-color-on-quiet: var(--wa-color-brand-on-quiet);
  }

  .wa-success,
  :host([variant='success']) {
    --wa-color-fill-loud: var(--wa-color-success-fill-loud);
    --wa-color-fill-normal: var(--wa-color-success-fill-normal);
    --wa-color-fill-quiet: var(--wa-color-success-fill-quiet);
    --wa-color-border-loud: var(--wa-color-success-border-loud);
    --wa-color-border-normal: var(--wa-color-success-border-normal);
    --wa-color-border-quiet: var(--wa-color-success-border-quiet);
    --wa-color-on-loud: var(--wa-color-success-on-loud);
    --wa-color-on-normal: var(--wa-color-success-on-normal);
    --wa-color-on-quiet: var(--wa-color-success-on-quiet);
  }

  .wa-warning,
  :host([variant='warning']) {
    --wa-color-fill-loud: var(--wa-color-warning-fill-loud);
    --wa-color-fill-normal: var(--wa-color-warning-fill-normal);
    --wa-color-fill-quiet: var(--wa-color-warning-fill-quiet);
    --wa-color-border-loud: var(--wa-color-warning-border-loud);
    --wa-color-border-normal: var(--wa-color-warning-border-normal);
    --wa-color-border-quiet: var(--wa-color-warning-border-quiet);
    --wa-color-on-loud: var(--wa-color-warning-on-loud);
    --wa-color-on-normal: var(--wa-color-warning-on-normal);
    --wa-color-on-quiet: var(--wa-color-warning-on-quiet);
  }

  .wa-danger,
  :host([variant='danger']) {
    --wa-color-fill-loud: var(--wa-color-danger-fill-loud);
    --wa-color-fill-normal: var(--wa-color-danger-fill-normal);
    --wa-color-fill-quiet: var(--wa-color-danger-fill-quiet);
    --wa-color-border-loud: var(--wa-color-danger-border-loud);
    --wa-color-border-normal: var(--wa-color-danger-border-normal);
    --wa-color-border-quiet: var(--wa-color-danger-border-quiet);
    --wa-color-on-loud: var(--wa-color-danger-on-loud);
    --wa-color-on-normal: var(--wa-color-danger-on-normal);
    --wa-color-on-quiet: var(--wa-color-danger-on-quiet);
  }
`,Ft=w`
  :host {
    --pulse-color: var(--wa-color-fill-loud, var(--wa-color-brand-fill-loud));

    display: inline-flex;
    align-items: center;
    justify-content: center;
    padding: 0.375em 0.625em;
    color: var(--wa-color-on-loud, var(--wa-color-brand-on-loud));
    font-size: max(var(--wa-font-size-3xs), 0.75em);
    font-weight: var(--wa-font-weight-semibold);
    line-height: 1;
    vertical-align: middle;
    white-space: nowrap;
    background-color: var(--wa-color-fill-loud, var(--wa-color-brand-fill-loud));
    border-color: transparent;
    border-radius: var(--wa-border-radius-s);
    border-style: var(--wa-border-style);
    border-width: var(--wa-border-width-s);
    user-select: none;
    -webkit-user-select: none;
    cursor: inherit;

    min-width: 1.25em; /* <-- this is what Safari respects for intrinsic */
    min-height: 1em;
  }

  /* Appearance modifiers */
  :host([appearance='outlined']) {
    --pulse-color: var(--wa-color-border-loud, var(--wa-color-brand-border-loud));

    color: var(--wa-color-on-quiet, var(--wa-color-brand-on-quiet));
    background-color: transparent;
    border-color: var(--wa-color-border-loud, var(--wa-color-brand-border-loud));
  }

  :host([appearance='filled']) {
    --pulse-color: var(--wa-color-fill-normal, var(--wa-color-brand-fill-normal));

    color: var(--wa-color-on-normal, var(--wa-color-brand-on-normal));
    background-color: var(--wa-color-fill-normal, var(--wa-color-brand-fill-normal));
    border-color: transparent;
  }

  :host([appearance='filled-outlined']) {
    --pulse-color: var(--wa-color-border-normal, var(--wa-color-brand-border-normal));

    color: var(--wa-color-on-normal, var(--wa-color-brand-on-normal));
    background-color: var(--wa-color-fill-normal, var(--wa-color-brand-fill-normal));
    border-color: var(--wa-color-border-normal, var(--wa-color-brand-border-normal));
  }

  :host([appearance='accent']) {
    --pulse-color: var(--wa-color-fill-loud, var(--wa-color-brand-fill-loud));

    color: var(--wa-color-on-loud, var(--wa-color-brand-on-loud));
    background-color: var(--wa-color-fill-loud, var(--wa-color-brand-fill-loud));
    border-color: transparent;
  }

  /* Pill modifier */
  :host([pill]) {
    border-radius: var(--wa-border-radius-pill);
  }

  /* Pulse attention */
  :host([attention='pulse']) {
    animation: pulse 1.5s infinite;
  }

  @keyframes pulse {
    0% {
      box-shadow: 0 0 0 0 var(--pulse-color);
    }
    70% {
      box-shadow: 0 0 0 0.5rem transparent;
    }
    100% {
      box-shadow: 0 0 0 0 transparent;
    }
  }

  /* Bounce attention */
  :host([attention='bounce']) {
    animation: bounce 1s cubic-bezier(0.28, 0.84, 0.42, 1) infinite;
  }

  @keyframes bounce {
    0%,
    20%,
    50%,
    80%,
    100% {
      transform: translateY(0);
    }
    40% {
      transform: translateY(-5px);
    }
    60% {
      transform: translateY(-2px);
    }
  }

  /* Prevents vertical space when icons with vertical-align are slotted in - https://github.com/shoelace-style/webawesome/issues/2280 */
  [part='start'],
  [part='end'] {
    line-height: 0;
  }

  slot[name='start']::slotted(*) {
    margin-inline-end: 0.375em;
  }

  slot[name='end']::slotted(*) {
    margin-inline-start: 0.375em;
  }
`,It=Object.defineProperty,Lt=Object.getOwnPropertyDescriptor,Rt=e=>{throw TypeError(e)},P=(e,t,n,r)=>{for(var i=r>1?void 0:r?Lt(t,n):t,a=e.length-1,o;a>=0;a--)(o=e[a])&&(i=(r?o(t,n,i):o(i))||i);return r&&i&&It(t,n,i),i},zt=(e,t,n)=>t.has(e)||Rt(`Cannot `+n),Bt=(e,t,n)=>(zt(e,t,`read from private field`),n?n.call(e):t.get(e)),Vt=(e,t,n)=>t.has(e)?Rt(`Cannot add the same private member more than once`):t instanceof WeakSet?t.add(e):t.set(e,n),Ht=(e,t,n,r)=>(zt(e,t,`write to private field`),r?r.call(e,n):t.set(e,n),n),F=e=>(t,n)=>{n===void 0?customElements.define(e,t):n.addInitializer(()=>{customElements.define(e,t)})},Ut;globalThis.litIssuedWarnings??=new Set,Ut=(e,t)=>{t+=` See https://lit.dev/msg/${e} for more information.`,!globalThis.litIssuedWarnings.has(t)&&!globalThis.litIssuedWarnings.has(e)&&(console.warn(t),globalThis.litIssuedWarnings.add(t))};var Wt=(e,t,n)=>{let r=t.hasOwnProperty(n);return t.constructor.createProperty(n,e),r?Object.getOwnPropertyDescriptor(t,n):void 0},Gt={attribute:!0,type:String,converter:ve,reflect:!1,hasChanged:ye},Kt=(e=Gt,t,n)=>{let{kind:r,metadata:i}=n;i??Ut(`missing-class-metadata`,`The class ${t} is missing decorator metadata. This could mean that you're using a compiler that supports decorators but doesn't support decorator metadata, such as TypeScript 5.1. Please update your compiler.`);let a=globalThis.litPropertyMetadata.get(i);if(a===void 0&&globalThis.litPropertyMetadata.set(i,a=new Map),r===`setter`&&(e=Object.create(e),e.wrapped=!0),a.set(n.name,e),r===`accessor`){let{name:r}=n;return{set(n){let i=t.get.call(this);t.set.call(this,n),this.requestUpdate(r,i,e,!0,n)},init(t){return t!==void 0&&this._$changeProperty(r,void 0,e,t),t}}}if(r===`setter`){let{name:r}=n;return function(n){let i=this[r];t.call(this,n),this.requestUpdate(r,i,e,!0,n)}}throw Error(`Unsupported decorator location: ${r}`)};function I(e){return(t,n)=>typeof n==`object`?Kt(e,t,n):Wt(e,t,n)}function L(e){return I({...e,state:!0,attribute:!1})}var qt=(e,t,n)=>(n.configurable=!0,n.enumerable=!0,Reflect.decorate&&typeof t!=`object`&&Object.defineProperty(e,t,n),n),Jt;globalThis.litIssuedWarnings??=new Set,Jt=(e,t)=>{t+=e?` See https://lit.dev/msg/${e} for more information.`:``,!globalThis.litIssuedWarnings.has(t)&&!globalThis.litIssuedWarnings.has(e)&&(console.warn(t),globalThis.litIssuedWarnings.add(t))};function R(e,t){return((n,r,i)=>{let a=n=>{let i=n.renderRoot?.querySelector(e)??null;if(i===null&&t&&!n.hasUpdated){let t=typeof r==`object`?r.name:r;Jt(``,`@query'd field ${JSON.stringify(String(t))} with the 'cache' flag set for selector '${e}' has been accessed before the first update and returned null. This is expected if the renderRoot tree has not been provided beforehand (e.g. via Declarative Shadow DOM). Therefore the value hasn't been cached.`)}return i};if(t){let{get:e,set:t}=typeof r==`object`?n:i??(()=>{let e=Symbol(`${String(r)} (@query() cache)`);return{get(){return this[e]},set(t){this[e]=t}}})();return qt(n,r,{get(){let n=e.call(this);return n===void 0&&(n=a(this),(n!==null||this.hasUpdated)&&t.call(this,n)),n}})}return qt(n,r,{get(){return a(this)}})})}var Yt=w`
  :host {
    box-sizing: border-box;
  }

  :host *,
  :host *::before,
  :host *::after {
    box-sizing: inherit;
  }

  [hidden],
  :host([hidden]) {
    display: none !important;
  }
`,Xt=/;\s+$/;function Zt(e){return e.replace(/[A-Z]/g,e=>`-${e.toLowerCase()}`)}function Qt(e){let{property:t,value:n,element:r}=e;if(n){let e=r.getAttribute(`style`)||``;e&&(e.match(Xt)||(e+=`;`),e+=` `);let i=`${t}: ${n}`;return e.includes(i)?void 0:`${e}${i};`}return null}var $t,z=class extends Mt{constructor(){super(),Vt(this,$t,!1),this.initialReflectedProperties=new Map,this.didSSR=!!this.shadowRoot,this.customStates={set:(e,t)=>{if(this.internals?.states)try{t?this.internals.states.add(e):this.internals.states.delete(e)}catch(e){if(String(e).includes(`must start with '--'`))console.error(`Your browser implements an outdated version of CustomStateSet. Consider using a polyfill`);else throw e}},has:e=>{if(!this.internals?.states)return!1;try{return this.internals.states.has(e)}catch{return!1}}};try{this.internals=this.attachInternals()}catch{console.error(`Element internals are not supported in your browser. Consider using a polyfill`)}this.customStates.set(`wa-defined`,!0);let e=this.constructor;for(let[t,n]of e.elementProperties)n.default===`inherit`&&n.initial!==void 0&&typeof t==`string`&&this.customStates.set(`initial-${t}-${n.initial}`,!0)}static get styles(){return[Yt,...Array.isArray(this.css)?this.css:this.css?[this.css]:[]]}connectedCallback(){super.connectedCallback(),this.didSSR||this.shadowRoot?.prepend(document.createComment(` Web Awesome: https://webawesome.com/docs/components/${this.localName.replace(`wa-`,``)} `)),this.didSSR&&this.updateComplete.then(()=>{this.shadowRoot?.prepend(document.createComment(` Web Awesome: https://webawesome.com/docs/components/${this.localName.replace(`wa-`,``)} `))})}attributeChangedCallback(e,t,n){Bt(this,$t)||(this.constructor.elementProperties.forEach((e,t)=>{e.reflect&&this[t]!=null&&this.initialReflectedProperties.set(t,this[t])}),Ht(this,$t,!0)),super.attributeChangedCallback(e,t,n)}willUpdate(e){super.willUpdate(e),this.initialReflectedProperties.forEach((t,n)=>{e.has(n)&&this[n]==null&&(this[n]=t)})}firstUpdated(e){super.firstUpdated(e),this.didSSR&&this.shadowRoot?.querySelectorAll(`slot`).forEach(e=>{e.dispatchEvent(new Event(`slotchange`,{bubbles:!0,composed:!1,cancelable:!1}))})}update(e){try{super.update(e)}catch(e){if(this.didSSR&&!this.hasUpdated){let t=new Event(`lit-hydration-error`,{bubbles:!0,composed:!0,cancelable:!1});t.error=e,this.dispatchEvent(t)}throw e}}setStyle(e,t){if(!this.style){let n=Qt({property:Zt(e),value:t,element:this});n&&this.setAttribute(`style`,n);return}this.style[e]=t}setStyleProperty(e,t){if(!this.style){let n=Qt({property:e,value:t,element:this});n&&this.setAttribute(`style`,n);return}this.style.setProperty(e,t)}relayNativeEvent(e,t){e.stopImmediatePropagation(),this.dispatchEvent(new e.constructor(e.type,{...e,...t}))}};$t=new WeakMap,P([I()],z.prototype,`dir`,2),P([I()],z.prototype,`lang`,2),P([I({type:Boolean,reflect:!0,attribute:`did-ssr`})],z.prototype,`didSSR`,2);var en=class extends z{constructor(){super(...arguments),this.variant=`brand`,this.appearance=`accent`,this.pill=!1,this.attention=`none`}render(){return j`
      <span part="start">
        <slot name="start"></slot>
      </span>

      <span part="base badge" role="status">
        <slot></slot>
      </span>

      <span part="end">
        <slot name="end"></slot>
      </span>
    `}};en.css=[Pt,Ft],P([I({reflect:!0})],en.prototype,`variant`,2),P([I({reflect:!0})],en.prototype,`appearance`,2),P([I({type:Boolean,reflect:!0})],en.prototype,`pill`,2),P([I({reflect:!0})],en.prototype,`attention`,2),en=P([F(`wa-badge`)],en);var tn=t({Tokens:()=>sn,default:()=>on});function nn(e,t){return`<div class="story-stack" style="gap:0.25rem">
    <span style="width:96px; height:48px; border-radius:10px; border:1px solid var(--c-line); background: var(${e}); display:inline-block"></span>
    <code style="font-size:0.7rem; color: var(--text-secondary)">${e}</code>
    <small style="font-size:0.65rem; color: var(--text-faint)">${t}</small>
  </div>`}function rn(){return[[`--bg`,`page background`],[`--surface`,`card surface`],[`--surface-2`,`subtle fill`],[`--surface-3`,`grey pill`],[`--c-line`,`hairlines + dividers`],[`--text`,`body text`],[`--text-secondary`,`secondary text`],[`--text-faint`,`decorative text`],[`--brand-blue`,`the one accent`],[`--brand-blue-bg`,`accent pill bg`],[`--ink`,`primary CTA fill`],[`--on-ink`,`CTA label`],[`--c-hazard`,`severity reinforcement`],[`--c-hazard-bg`,`severity pill bg`]].map(([e,t])=>nn(e,t)).join(``)}function an(){return[`--radius`,`--radius-sm`,`--radius-pill`,`--shadow`,`--shadow-lift`].map(e=>`<div class="story-stack" style="gap:0.25rem">
      <span style="width:96px; height:48px; background: var(--surface); display:inline-block; ${e===`--shadow-lift`||e===`--shadow`?`box-shadow: var(${e});`:``} ${e.startsWith(`--radius`)?`border:1px solid var(--c-line); border-radius: var(${e});`:``}"></span>
      <code style="font-size:0.7rem; color: var(--text-secondary)">${e}</code>
    </div>`).join(``)}var on={title:`Foundations/Tokens`,parameters:{renderer:`html`}},sn={name:`Tokens`,render:()=>`
    <p class="story-label">Color tokens (light values shown; flip the Dark mode toolbar toggle)</p>
    <div class="story-row" style="align-items:flex-start">${rn()}</div>
    <p class="story-label">Shape + elevation</p>
    <div class="story-row" style="align-items:flex-end">${an()}</div>
    <p class="story-label">Rules</p>
    <div class="story-stack" style="max-width:420px; align-items:flex-start; gap:0.4rem">
      <small>1. Tokens only — never hard-code a hex in component CSS.</small>
      <small>2. Color never carries meaning alone (WCAG 1.4.1) — pair with label/icon.</small>
      <small>3. Dark mode is a token swap under html.wa-dark; use the toolbar toggle.</small>
    </div>
  `,source:()=>`/* Tokens live in frontend/src/styles/tokens.css — use var(--token), never hex */`},cn=t({Default:()=>un,Otp:()=>dn,default:()=>ln}),ln={title:`Web Awesome/Form controls`,parameters:{renderer:`html`},source:()=>`/* Canonical usage (design doc, Forms):
<div class="stack">
  <wa-input label="Place name" type="text"></wa-input>
  <wa-textarea label="Describe the issue" resize="vertical" rows="4"></wa-textarea>
  <wa-checkbox>Include photo</wa-checkbox>
</div>
<button class="btn-ink" type="submit">Submit</button> */`},un={name:`Canonical usage`,render:()=>`
    <form class="story-stack" style="align-items:stretch; width:min(360px, 100%)"
      onsubmit="return false">
      <wa-input label="Place name" type="text" autocomplete="off"></wa-input>
      <wa-textarea label="Describe the issue" resize="vertical" rows="3"></wa-textarea>
      <wa-checkbox checked>Include a photo</wa-checkbox>
      <div class="story-row" style="justify-content:flex-start; margin-top:0.5rem">
        <button class="btn-ink" type="submit">Submit</button>
        <button class="btn-outline" type="button">Cancel</button>
      </div>
    </form>`,source:()=>`/* Canonical usage (design doc, Forms):
<div class="stack">
  <wa-input label="Place name" type="text"></wa-input>
  <wa-textarea label="Describe the issue" resize="vertical" rows="3"></wa-textarea>
  <wa-checkbox checked>Include a photo</wa-checkbox>
</div>
<button class="btn-ink" type="submit">Submit</button> */`},dn={name:`OTP input (login)`,render:()=>`
    <div class="story-stack" style="width:min(360px, 100%)">
      <wa-otp-input label="Site code" length="6" type="alphanumeric" case="upper"></wa-otp-input>
    </div>`,source:`<wa-otp-input label="Site code" length="6" type="alphanumeric" case="upper"></wa-otp-input>`},fn=`:root{--lightningcss-light:initial;--lightningcss-dark: ;color-scheme:light;--font-sans:-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;--brand-blue:#155fce;--brand-blue-bg:#e8f0fe;--c-hazard:#b42318;--c-hazard-bg:#fdecea;--c-flag:#b45309;--bg:#fafafa;--surface:#fff;--surface-2:#f5f5f5;--surface-3:#f0f0f0;--c-line:#e5e5e5;--ink:#262626;--on-ink:#fff;--text:#171717;--text-secondary:#666;--text-faint:#767676;--c-blue:var(--brand-blue);--muted:var(--text-secondary);--c-red:var(--c-hazard);--radius:12px;--radius-sm:8px;--radius-pill:999px;--shadow:0 1px 2px #1018280f, 0 1px 3px #1018281a;--shadow-lift:0 4px 10px #1018281a, 0 12px 24px #1018281a;--toast-success:#00883c;--toast-shadow:0 4px 4px #0000001f;--timeline-done-fill:#000;--timeline-done-mark:#fff}html.wa-dark{--lightningcss-light: ;--lightningcss-dark:initial;color-scheme:dark;--brand-blue:#6ba7f0;--brand-blue-bg:#17273d;--c-hazard:#f2938a;--c-hazard-bg:#2a1614;--c-flag:#e8a54d;--bg:#0f0f0f;--surface:#1a1a1a;--surface-2:#242424;--surface-3:#2a2a2a;--c-line:#333;--ink:#ededed;--on-ink:#131313;--text:#ededed;--text-secondary:#a8a8a8;--text-faint:#8f8f8f;--shadow:0 1px 2px #0006, 0 1px 3px #00000080;--shadow-lift:0 4px 10px #00000080, 0 12px 24px #00000080;--toast-success:#6bdc94;--toast-shadow:0 4px 4px #0006;--timeline-done-fill:#fff;--timeline-done-mark:#000}`,pn=`*,:before,:after{box-sizing:border-box}:where(wa-input,wa-textarea,wa-select,wa-option,wa-badge,wa-callout,wa-spinner,wa-icon):not(:defined){visibility:hidden}html,body{background:var(--bg);overscroll-behavior:none;scrollbar-gutter:stable;height:100%}body{font-family:var(--font-sans);background:var(--bg);color:var(--text);-webkit-text-size-adjust:100%;margin:0;line-height:1.5}@media (prefers-reduced-motion:reduce){*,:before,:after{scroll-behavior:auto!important;transition-duration:.001ms!important;animation-duration:.001ms!important;animation-iteration-count:1!important}}.visually-hidden{clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;position:absolute!important}.app{flex-direction:column;min-height:100svh;display:flex}.app__header{padding:.75rem 1rem;padding-top:max(.75rem, env(safe-area-inset-top));background:var(--surface);border-bottom:1px solid var(--c-line);z-index:10;align-items:center;gap:.75rem;display:flex;position:sticky;top:0}.app__home{color:inherit;text-decoration:none;display:block}.app__home:focus-visible{outline:2px solid var(--c-blue);outline-offset:2px;border-radius:4px}.app__title{margin:0;font-size:1.05rem;font-weight:650;display:block}.app__kicker{color:var(--text-secondary);letter-spacing:.04em;text-transform:uppercase;font-size:.72rem}.app__spacer{flex:1}.app__main{width:min(720px,100%);padding:1rem;padding-bottom:calc(2rem + env(safe-area-inset-bottom));flex:1;margin-inline:auto}.app__main:has(.guidance-harness){width:100%;max-width:none}.app__main:has(.check-timeline){width:min(72rem,100%);max-width:none;padding-inline:clamp(1rem,4vw,3rem)}.card{background:var(--surface);border:1px solid var(--c-line);border-radius:var(--radius);box-shadow:var(--shadow);padding:1rem}.stack{flex-direction:column;gap:1rem;display:flex}.stack--tight{gap:.5rem}h1,h2{line-height:1.2}h2{margin:0 0 .25rem;font-size:1.15rem}p.hint{color:var(--muted);margin:.1rem 0 0;font-size:.9rem}label{margin-bottom:.35rem;font-weight:600;display:block}form>wa-button[type=submit]{width:100%;display:block}.app__main:has(.login){background:var(--surface);width:100%;max-width:none;padding:0}.login{background:var(--surface);min-height:100svh;color:var(--text);place-items:center;padding:2rem 1rem;display:grid}.login__panel{text-align:center;flex-direction:column;align-items:center;gap:32px;width:min(100%,440px);display:flex}.login__mark{background-color:var(--surface-2);background-image:linear-gradient(45deg, var(--surface-3) 25%, transparent 25%), linear-gradient(-45deg, var(--surface-3) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--surface-3) 75%), linear-gradient(-45deg, transparent 75%, var(--surface-3) 75%);background-position:0 0,0 8px,8px -8px,-8px 0;background-size:16px 16px;border-radius:4px;width:160px;height:160px}.login__copy h1{color:var(--text);margin:0;font-size:32px;font-weight:700;line-height:40px}.login__copy p{max-width:100%;color:var(--text);text-wrap:balance;margin:0;font-size:32px;line-height:40px}.login__form{flex-direction:column;align-items:center;margin-top:0;display:flex}.login__otp::part(segments){justify-content:center;padding:1rem}.login__otp::part(label){clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.login__otp--error::part(segment){border-color:var(--c-hazard);color:var(--c-hazard)}.login__error{color:var(--c-hazard);margin:32px 0 0;font-size:16px;font-weight:400;line-height:24px}.login__error[hidden]{display:none}.btn-ink.login__continue{border-radius:32px;place-items:center;min-width:0;min-height:0;margin-top:32px;padding:12px 32px;font-size:20px;font-weight:400;line-height:32px;display:inline-grid}.login__form--error .btn-ink.login__continue{margin-top:16px}.btn-ink.login__continue:disabled{cursor:not-allowed;background:var(--surface-3);color:var(--text-faint)}.btn-ink.login__continue wa-spinner{width:32px;height:32px;color:var(--text-faint);--track-width:3px;font-size:32px}.login__link{color:var(--text-secondary);font:inherit;text-underline-offset:.2em;cursor:pointer;background:0 0;border:0;text-decoration:underline}.login__request{text-align:left;gap:16px;width:min(100%,360px);display:grid}.login__field{color:var(--text);gap:6px;font-size:.875rem;line-height:1.429;display:grid}.login__field input{border:1px solid var(--c-line);background:var(--surface);width:100%;min-height:44px;color:var(--text);font:inherit;border-radius:8px;padding:10px 12px}.login__results{gap:8px;display:grid}.login__result{border:1px solid var(--c-line);background:var(--surface);width:100%;color:var(--text);text-align:left;cursor:pointer;border-radius:8px;gap:2px;padding:10px 12px;display:grid}.login__result--selected{border-color:var(--text);box-shadow:0 0 0 2px var(--surface-3)}.login__result small,.login__hint{color:var(--text-secondary)}.login__message{color:var(--text);margin:0;font-size:1rem;line-height:1.5}@media (width<=480px){.login{padding-inline:0}.login__mark{width:132px;height:132px}.login__copy h1,.login__copy p{font-size:1.65rem}}.setup .btn-ink,.setup .btn-outline{width:100%}.setup__actions{flex-direction:column;gap:.6rem;display:flex}.setup__manual{margin-top:.25rem}.setup__manual summary{cursor:pointer;color:var(--text-secondary);width:max-content;padding:.35rem 0;font-size:.9rem}.setup__manual summary:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px;border-radius:4px}.app__main:has(.places-flow){background:var(--surface);width:100%;max-width:none;padding:0}.places-flow{background:var(--surface);min-height:100svh;color:var(--text);place-items:center;padding:4rem 1.5rem;display:grid;position:relative}.places-flow__back,.home-settings{appearance:none;border-radius:var(--radius-pill);background:var(--surface-3);width:44px;height:44px;color:var(--text);cursor:pointer;box-shadow:none;border:0;place-items:center;margin:0;padding:0;display:inline-grid}.places-flow__back{top:max(1rem, env(safe-area-inset-top));z-index:2;position:fixed;left:1rem}.places-flow__panel{flex-direction:column;justify-content:center;align-items:center;gap:32px;width:min(100%,480px);display:flex}.places-flow__copy{text-align:center;flex-direction:column;gap:8px;display:flex}.places-flow__title{color:var(--text);font-size:var(--wa-font-size-3xl,2.5rem);text-wrap:balance;margin:0;font-weight:700;line-height:1.2}.places-flow__subtitle{color:var(--text-secondary);font-size:var(--wa-font-size-l,1.25rem);white-space:pre-line;text-wrap:balance;margin:0;font-weight:600;line-height:1.2}.places-flow__site{color:var(--text);font-size:var(--wa-font-size-l,1.25rem);text-align:center;margin:0;font-weight:700;line-height:1.2}.places-list{flex-direction:column;gap:12px;width:100%;margin:0;padding:0;list-style:none;display:flex}.places-row{grid-template-columns:43px minmax(0,1fr) 62px;align-items:center;gap:8px;display:grid;position:relative}.places-row--single{grid-template-columns:minmax(0,1fr)}.places-row__number{min-height:62px;color:var(--wa-color-neutral-on-normal);font-family:"Font Awesome 7 Free", var(--wa-font-family-body);font-size:var(--wa-font-size-m,1rem);text-align:center;place-items:center;font-style:normal;font-weight:900;line-height:1.2;display:inline-grid}.places-row__input{--wa-form-control-height:62px;--wa-form-control-border-radius:8px;--wa-form-control-padding-block:0;width:100%;min-width:0;display:block}.places-row__input::part(form-control-label){clip:rect(0 0 0 0);clip-path:inset(50%);white-space:nowrap;border:0;width:1px;height:1px;margin:-1px;padding:0;position:absolute;overflow:hidden}.places-row__input::part(input-wrapper){min-height:62px;box-shadow:none;border-radius:8px}.places-row__input::part(input){align-items:center;height:60px;min-height:60px;line-height:1.2;display:flex}.places-row__menu-wrap{position:relative}.places-row__menu-button{appearance:none;border-radius:var(--radius-pill);background:var(--surface-2);width:62px;height:62px;color:var(--text);cursor:pointer;box-shadow:none;border:0;place-items:center;margin:0;padding:0;font-size:1rem;line-height:1;display:inline-grid}.places-row__menu-button wa-icon{font-size:1.375rem}.places-row__dots,.places-row__dots:before,.places-row__dots:after{border-radius:var(--radius-pill);background:currentColor;width:5px;height:5px}.places-row__dots{display:block;position:relative}.places-row__dots:before,.places-row__dots:after{content:"";position:absolute;left:0}.places-row__dots:before{top:-9px}.places-row__dots:after{top:9px}.places-menu{z-index:5;background:var(--surface);width:min(276px,100vw - 2rem);box-shadow:none;border-radius:16px;flex-direction:column;align-items:stretch;gap:2px;padding:8px;display:flex;position:absolute;top:calc(100% + 8px);left:0;right:auto}.places-menu__item{appearance:none;min-height:44px;color:var(--text);text-align:left;width:100%;font:inherit;cursor:pointer;box-shadow:none;background:0 0;border:0;border-radius:3px;justify-content:flex-start;align-items:center;gap:8px;margin:0;padding:12px 16px;display:flex}.places-menu__item:disabled{cursor:not-allowed;color:var(--text-faint)}.places-menu__item--danger{color:var(--c-hazard)}.places-flow__future-note{color:var(--wa-color-text-quiet);text-align:center;font-family:var(--wa-font-family-body);font-size:var(--wa-font-size-m);font-style:normal;font-weight:var(--wa-font-weight-body);margin:0;line-height:1.6}.places-flow__error{color:var(--c-hazard);text-align:center;font-family:var(--wa-font-family-body);font-size:var(--wa-font-size-m);font-style:normal;font-weight:var(--wa-font-weight-body);margin:0;line-height:1.4}.places-flow__actions{flex-wrap:wrap;justify-content:center;gap:8px;display:flex}.places-flow__button{font-size:var(--wa-font-size-l,1.25rem)}.places-flow__button--add{white-space:nowrap;flex:none;width:fit-content;min-width:0;padding-inline:1.5rem}.places-flow__button:disabled,.places-row__menu-button:disabled{cursor:not-allowed;opacity:.5}.places-modal{background:var(--surface);width:min(400px,100vw - 2rem);box-shadow:none;border:0;border-radius:24px;padding:0;overflow:hidden}.places-modal::backdrop{background:color-mix(in srgb, var(--text) 64%, transparent)}.places-modal__card{border-radius:inherit;box-shadow:none;background:0 0;flex-direction:column;gap:32px;margin:0;padding:24px;display:flex}.places-modal__copy{flex-direction:column;gap:4px;display:flex}.places-modal__title{color:var(--text);font-size:var(--wa-font-size-xl,1.5625rem);margin:0;line-height:1.2}.places-modal__text{color:var(--text-secondary);font-size:var(--wa-font-size-m,1rem);margin:0;line-height:1.6}.places-modal__actions{flex-direction:column;gap:4px;display:flex}.places-modal__primary{width:100%;min-height:54px;display:block}.places-modal__danger{appearance:none;border-radius:var(--radius-pill);width:100%;height:54px;min-height:54px;color:var(--c-hazard);cursor:pointer;box-shadow:none;background:0 0;border:0;margin:0;padding:0 1rem;font-size:1rem;font-weight:700;line-height:1.1}.places-flow__back:focus-visible,.home-settings:focus-visible,.places-row__menu-button:focus-visible,.places-menu__item:focus-visible,.places-modal__danger:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px}.home{position:relative}.home-top-actions{box-sizing:border-box;z-index:2;justify-content:space-between;align-items:center;width:min(100%,550px);min-height:2.75rem;margin:0 auto .75rem;padding-inline:.25rem;display:flex;position:relative}.home-settings{background:0 0;flex:none}.home-settings__icon{background:currentColor;width:1.25rem;height:1.25rem;display:block;-webkit-mask:url(`+new URL(`icons/gear.svg`,import.meta.url).href+`) 50%/contain no-repeat;mask:url(`+new URL(`icons/gear.svg`,import.meta.url).href+`) 50%/contain no-repeat}@media (width<=540px){.places-flow{padding-inline:1rem}.places-flow__title{font-size:2rem}.places-flow__subtitle{font-size:1.05rem}.places-row{grid-template-columns:32px minmax(0,1fr) 43px}}.media-preview img{border-radius:var(--radius-sm);max-width:100%;display:block}.media-preview audio{width:100%}.empty{text-align:center;color:var(--muted);padding:2.5rem 1rem}theme-toggle{top:max(.6rem, env(safe-area-inset-top));z-index:20;position:fixed;right:.6rem}.eyebrow{color:var(--text-secondary);margin:0;font-size:.85rem}.center{text-align:center}.app--chromeless .app__header{display:none}.app--chromeless .app__main{padding-top:max(1rem, env(safe-area-inset-top))}.home{width:min(100%,550px);max-width:550px;margin-inline:auto}.home-region{will-change:opacity, transform;transition:opacity .22s,transform .26s}.home-region--header{opacity:1;transform:translateY(0)}.home-region--capture{opacity:0;display:none;transform:translateY(-2rem)}.home-region--results{opacity:1;transform:translateY(0)}.home--entering-capture .home-region--header,.home--capture .home-region--header{pointer-events:none;opacity:0;position:absolute;inset-block-start:0;inset-inline:0;transform:translateY(-.75rem)}.home--capture .home-region--header{display:none}.home--entering-capture .home-region--capture,.home--capture .home-region--capture,.home--leaving-capture .home-region--capture{display:block}.home--entering-capture .home-region--capture,.home--capture .home-region--capture{animation:.26s both home-capture-in}.home--leaving-capture .home-region--capture{pointer-events:none;z-index:2;animation:.26s both home-capture-out;position:absolute;inset-block-start:0;inset-inline:0}.home--entering-capture .home-region--results,.home--capture .home-region--results{pointer-events:none;opacity:0;transform:translateY(2rem)}.home--leaving-capture .home-region--header{animation:.26s both home-fade-in}.home--leaving-capture .home-region--results{animation:.26s both home-results-up}@keyframes home-capture-in{0%{opacity:0;transform:translateY(-2rem)}to{opacity:1;transform:translateY(0)}}@keyframes home-capture-out{0%{opacity:1;transform:translateY(0)}to{opacity:0;transform:translateY(-2rem)}}@keyframes home-results-up{0%{opacity:1;transform:translateY(2rem)}to{opacity:1;transform:translateY(0)}}@keyframes home-fade-in{0%{opacity:0}to{opacity:1}}@media (prefers-reduced-motion:reduce){.home-region{transition-duration:1ms}.home--entering-capture .home-region--capture,.home--capture .home-region--capture,.home--leaving-capture .home-region--capture,.home--leaving-capture .home-region--header,.home--leaving-capture .home-region--results{animation-duration:1ms}}.home--first-run{width:100%;max-width:none;min-height:calc(100dvh - max(1rem, env(safe-area-inset-top)) - 1.5rem);flex-direction:column;justify-content:flex-start;align-items:center;display:flex}.home--first-run .home-region--header{flex-direction:column;flex:1;width:100%;display:flex}.screen{background:var(--surface);border:1px solid var(--c-line);box-shadow:var(--shadow);border-radius:20px;overflow:hidden}.screen--today-hero{box-shadow:none;background:0 0;border:0;border-radius:0;overflow:visible}.screen--first-run{width:100%;min-height:min(47rem, calc(100dvh - max(1rem, env(safe-area-inset-top)) - 2rem));flex:1;display:flex}.screen__sec{padding:1.25rem 1.35rem}.screen__sec+.screen__sec{border-top:1px solid var(--c-line)}.sitehead{text-align:center}.sitehead__name{font-size:1.2rem;font-weight:600;line-height:1.2}.home-lead{flex-direction:column;gap:1.1rem;display:flex}.home-lead--first-run{flex:1;justify-content:center;align-items:center;padding:2.5rem 1.75rem}.home-first-run{text-align:center;flex-direction:column;justify-content:center;align-items:center;gap:1.65rem;width:100%;display:flex}.home-first-run__title{text-wrap:balance;max-width:9ch;margin:0;font-size:clamp(2rem,7vw,3.15rem);font-weight:700;line-height:1.05}.home-identity{text-align:center;flex-direction:column;align-items:center;gap:.3rem;display:flex}.home-identity__org{color:var(--text-secondary);letter-spacing:.06em;text-transform:uppercase;margin:0;font-size:.82rem;font-weight:700}.home-identity__site{text-wrap:balance;margin:0;font-size:clamp(1.9rem,6vw,2.45rem);font-weight:700;line-height:1.12}.home-actions{flex-wrap:wrap;justify-content:center;gap:.75rem;display:flex}.home-actions--stacked{flex-direction:column;align-items:center}.home-actions .btn-ink,.home-actions .btn-outline{min-width:12.25rem}.home-actions--stacked .btn-ink,.home-actions--stacked .btn-outline{width:auto}.btn-ink{appearance:none;cursor:pointer;background:var(--ink);color:var(--on-ink);font:inherit;border-radius:var(--radius-pill);height:auto;min-height:46px;box-shadow:none;border:0;margin:0;padding:.7rem 2.3rem;font-size:1rem;font-weight:700;line-height:1.1}.btn-ink:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px}button[data-loading]{min-width:var(--btn-loading-min-width,auto);cursor:progress}button[data-loading] wa-spinner{vertical-align:-.25em;display:inline-block}button[data-loading] [data-loading-label]{visibility:hidden}.home-cta__link{appearance:none;cursor:pointer;width:100%;font:inherit;color:var(--text-secondary);box-shadow:none;background:0 0;border:0;height:auto;margin-top:.7rem;padding:.3rem;font-weight:600;display:block}.home-cta__link:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px;border-radius:6px}.lastlog{text-align:center;flex-direction:column;align-items:center;gap:.45rem;padding-top:.15rem;display:flex}.lastlog__summary{text-wrap:pretty;max-width:26ch;margin:0;font-size:clamp(1.2rem,4vw,1.55rem);font-style:italic;font-weight:600;line-height:1.32}.lastlog__eyebrow{color:var(--text-secondary);letter-spacing:.06em;text-transform:uppercase;margin:0;font-size:.75rem;font-weight:600}.home-divider{background:var(--c-line);width:100%;max-width:550px;height:1px;margin:1.5rem auto 1.15rem}.home-capture{margin-top:1.5rem}.home--has-capture .home-capture{margin-top:0}.home-capture .check-timeline{width:100%;min-height:auto;padding:0}.home-capture .single-issue{width:100%;max-width:none;min-height:auto;padding:0}.single-issue{gap:1.25rem}.single-issue__title{color:var(--text);font-family:var(--wa-font-family-heading,var(--font-sans));font-size:var(--wa-font-size-2xl,2rem);font-weight:var(--wa-font-weight-heading,600);letter-spacing:0;margin:0;line-height:1.2}.single-issue .shotgrid{flex:none;margin-bottom:0}.single-issue__describe{align-self:center;margin-top:-.5rem}.single-issue .check__actions{justify-content:flex-start}.single-issue__analysis{width:100%}.check-timeline--embedded{background:0 0}.home-results{flex-direction:column;gap:1rem;width:100%;display:flex}.home-results .analysis-tray{margin-top:0}.home-results__divider{background:var(--c-line);width:100%;height:1px}.home-results__cards{flex-direction:column;gap:.75rem;display:flex}.home-wrap{background:var(--surface);box-sizing:border-box;border-radius:.875rem;width:100%;padding:1rem}.home-wrap h2{color:var(--brand-blue);letter-spacing:0;margin:0 0 .35rem;font-size:1.45rem;font-weight:700;line-height:1.15}.home-wrap p{color:var(--text-secondary);text-wrap:pretty;margin:0;font-size:1rem;font-weight:500;line-height:1.45}.home-wrap__link{color:var(--brand-blue);font:inherit;text-underline-offset:.16em;font-weight:700;text-decoration:underline}.home-wrap__link:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px;border-radius:4px}.task-filter{z-index:3;width:max-content;max-width:100%;position:relative}.task-filter__button{appearance:none;border:1px solid var(--wa-color-neutral-border-loud,var(--text));border-radius:var(--radius-pill);background:var(--surface);min-height:2.375rem;color:var(--text);cursor:pointer;font:inherit;font-size:var(--wa-font-size-s,.875rem);box-shadow:none;text-shadow:none;justify-content:center;align-items:center;gap:.625rem;margin:0;padding:.5rem 1rem;font-weight:700;line-height:1.2;display:inline-flex}.task-filter__caret{border-bottom:2px solid;border-right:2px solid;width:.625rem;height:.625rem;transform:translateY(-.125rem)rotate(45deg)}.task-filter__caret--up{transform:translateY(.125rem)rotate(225deg)}.task-filter__menu{z-index:4;background:var(--surface);min-width:max(13rem,100%);box-shadow:var(--shadow);border-radius:1rem;padding:.5rem;position:absolute;top:calc(100% + .5rem);left:0}.task-filter__item{appearance:none;width:100%;min-height:2.75rem;color:var(--text);cursor:pointer;font:inherit;font-size:var(--wa-font-size-s,.875rem);text-align:left;white-space:nowrap;background:0 0;border:0;border-radius:.75rem;align-items:center;padding:.75rem 1rem;font-weight:600;line-height:1.2;display:flex}.task-filter__item--active{background:var(--surface-2)}.assessment-tile{background:color-mix(in srgb, var(--brand-blue) 12%, var(--surface));border-radius:18px;padding:.75rem}.assessment-tile__card{background:var(--surface);border-radius:12px;flex-direction:column;gap:.55rem;padding:1rem 3.25rem 1rem 1.1rem;display:flex;position:relative}.assessment-tile__top{display:block}.assessment-tile__eyebrow{color:var(--text-faint);letter-spacing:.05em;text-transform:uppercase;align-items:center;gap:.45rem;margin:0;font-size:.66rem;font-weight:700;display:flex}.assessment-tile__spark{color:var(--brand-blue);font-size:.78rem;line-height:1}.assessment-tile__dismiss{color:var(--text-secondary);position:absolute;top:.35rem;right:.45rem}.assessment-tile__headline{color:var(--brand-blue);text-wrap:pretty;margin:0;font-size:1.05rem;font-weight:700;line-height:1.45}.assessment-tile__progress{background:var(--surface-3);border-radius:999px;width:100%;height:4px;position:relative;overflow:hidden}.assessment-tile__bar{border-radius:inherit;background:color-mix(in srgb, var(--text) 78%, var(--surface));width:34%;animation:1.8s ease-in-out infinite alternate assessment-slide;position:absolute;inset-block:0}.assessment-tile--error{background:color-mix(in srgb, var(--danger,#b42318) 12%, var(--surface))}.assessment-tile--error .assessment-tile__headline{color:var(--danger,#b42318)}.assessment-tile__actions{justify-content:flex-start;margin-top:.15rem;display:flex}@keyframes assessment-slide{0%{transform:translate(-8%)}to{transform:translate(205%)}}@media (prefers-reduced-motion:reduce){.assessment-tile__bar{animation:none;transform:translate(90%)}}.worklist{flex-direction:column;gap:1rem;margin-top:1.25rem;display:flex}.worklist__counter{color:var(--text-secondary);letter-spacing:.06em;text-transform:uppercase;margin:0 0 -.15rem;padding-inline:.35rem;font-size:.82rem;font-weight:700}.worklist__group{background:var(--surface-2);border:1px solid var(--c-line);border-radius:16px;flex-direction:column;gap:.7rem;padding:.9rem;display:flex}.worklist__label{letter-spacing:.06em;text-transform:uppercase;color:var(--text-secondary);margin:0;padding-inline:.15rem;font-size:.8rem;font-weight:700}.worklist__group--city .worklist__label{color:var(--brand-blue)}.worklist__cards{flex-direction:column;gap:.6rem;display:flex}.actioncard{background:var(--surface);border:1px solid var(--c-line);border-radius:12px;padding:.85rem .95rem}.actioncard__time{color:var(--text-faint);letter-spacing:.05em;margin-bottom:.3rem;font-size:.78rem;font-weight:600;display:block}.actioncard__title{margin:0;font-size:1.05rem;font-weight:700;line-height:1.25}.actioncard__detail{color:var(--text-secondary);overflow-wrap:anywhere;margin:.25rem 0 0;font-size:.95rem;line-height:1.4}.actioncard__category{color:var(--text-secondary);overflow-wrap:anywhere;margin:.12rem 0 0;font-size:.9rem;line-height:1.4}.actioncard__actions{flex-wrap:wrap;gap:.5rem;margin-top:.85rem;display:flex}.actioncard__error{color:var(--danger,#b42318);margin:.6rem 0 0;font-size:.9rem}.actioncard__cancel{width:auto;margin-top:0;padding-inline:.4rem}.pill{letter-spacing:.06em;text-transform:uppercase;border-radius:var(--radius-pill);white-space:nowrap;align-items:center;padding:.28rem .6rem;font-size:.72rem;font-weight:700;display:inline-flex}.pill--route,.pill--confirm{color:var(--brand-blue);background:var(--brand-blue-bg)}.pill--pending,.pill--sev{color:var(--text-secondary);background:var(--surface-3)}.btn-outline{appearance:none;cursor:pointer;color:var(--text);border:1px solid var(--c-line);font:inherit;border-radius:var(--radius-pill);height:auto;min-height:46px;box-shadow:none;background:0 0;margin:0;padding:.7rem 2.3rem;font-size:1rem;font-weight:700}.btn-outline:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px}.btn-blue{appearance:none;cursor:pointer;background:var(--brand-blue);color:var(--on-ink);font:inherit;border-radius:var(--radius-pill);height:auto;min-height:46px;box-shadow:none;border:0;margin:0;padding:.7rem 2.3rem;font-size:1rem;font-weight:700}.btn-blue:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px}.btn-ink--sm,.btn-outline--sm,.btn-blue--sm{white-space:nowrap;min-height:38px;padding:.45rem 1.2rem;font-size:.9rem}.guidance-harness{width:min(1180px,100%);margin:0 auto;padding:1rem 0 2rem}.guidance-harness__header{align-items:flex-start;gap:1rem;margin-bottom:1rem;display:flex}.guidance-harness__back{color:var(--text-secondary);flex:none;padding:.35rem 0;font-weight:700;text-decoration:none}.guidance-harness__back:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px;border-radius:6px}.guidance-harness__eyebrow{color:var(--text-secondary);letter-spacing:.06em;margin:0 0 .2rem;font-size:.78rem;font-weight:700}.guidance-harness h1{margin:0;font-size:1.8rem}.guidance-harness__layout{grid-template-columns:minmax(360px,.95fr) minmax(420px,1.05fr);align-items:start;gap:1rem;display:grid}.guidance-harness__editor{background:var(--surface);border:1px solid var(--c-line);border-radius:var(--radius-sm);padding:1rem}.guidance-harness__results{min-width:0}.guidance-harness__controls{grid-template-columns:minmax(0,1fr) auto;align-items:end;gap:.75rem;margin-bottom:.85rem;display:grid}.guidance-harness__controls--three{grid-template-columns:repeat(3,minmax(0,1fr))}.guidance-harness wa-select,.guidance-harness wa-input,.guidance-harness wa-textarea{width:100%}.guidance-harness wa-checkbox{margin-bottom:.85rem}.guidance-harness wa-textarea::part(textarea){min-height:430px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.86rem;line-height:1.45}.guidance-harness__actions,.guidance-question__actions{flex-wrap:wrap;align-items:center;gap:.65rem;margin-top:.9rem;display:flex}.guidance-harness__error{color:var(--c-hazard);margin:.85rem 0 0;font-weight:700}.guidance-harness__empty{border:1px dashed var(--c-line);border-radius:var(--radius-sm);background:var(--surface);padding:1rem}.guidance-harness__empty h2,.guidance-section h2{margin:0 0 .75rem;font-size:1.05rem}.guidance-harness__empty p,.guidance-harness__muted{color:var(--text-secondary);margin:0}.guidance-section+.guidance-section{margin-top:1.25rem}.guidance-list{gap:.75rem;display:grid}.guidance-card{background:var(--surface);border:1px solid var(--c-line);border-radius:var(--radius-sm);padding:.9rem}.guidance-card__top{justify-content:space-between;align-items:start;gap:.75rem;margin-bottom:.65rem;display:flex}.guidance-card h3{margin:0;font-size:1rem;line-height:1.25}.guidance-card p{color:var(--text-secondary);overflow-wrap:anywhere;margin:.7rem 0 0}.guidance-pill{border-radius:var(--radius-pill);background:var(--surface-3);color:var(--text-secondary);text-transform:uppercase;flex:none;padding:.24rem .55rem;font-size:.74rem;font-weight:700}.guidance-kv{grid-template-columns:repeat(4,minmax(0,1fr));gap:.65rem;margin:0;display:grid}.guidance-kv--compact{grid-template-columns:repeat(3,minmax(0,1fr))}.guidance-kv div{min-width:0}.guidance-kv dt{color:var(--text-secondary);text-transform:uppercase;font-size:.74rem;font-weight:700}.guidance-kv dd{overflow-wrap:anywhere;margin:.1rem 0 0;font-weight:700}.guidance-question{border-top:1px solid var(--c-line);margin-top:.85rem;padding-top:.85rem}.guidance-question p{color:var(--text);font-weight:700}.guidance-actions{color:var(--text-secondary);margin:.8rem 0 0;padding-left:1.2rem;font-size:.86rem}.guidance-actions code{color:var(--text);font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}.guidance-harness__raw{grid-template-columns:repeat(2,minmax(0,1fr));gap:1rem;margin-top:1.25rem;display:grid}.guidance-harness__raw details{background:var(--surface);border:1px solid var(--c-line);border-radius:var(--radius-sm);padding:.75rem}.guidance-harness__raw summary{cursor:pointer;font-weight:700}.guidance-harness__raw pre{border-radius:var(--radius-sm);background:var(--surface-2);max-height:360px;color:var(--text);margin:.75rem 0 0;padding:.75rem;font-size:.8rem;line-height:1.45;overflow:auto}@media (width<=900px){.guidance-harness__layout,.guidance-harness__raw,.guidance-harness__controls,.guidance-harness__controls--three,.guidance-kv,.guidance-kv--compact{grid-template-columns:1fr}}.flow{max-width:460px;margin:0 auto;padding:0 1.1rem 2rem}.topbar{border-bottom:1px solid var(--c-line);align-items:center;gap:.9rem;margin-bottom:1.25rem;padding:1rem 0 .9rem;display:flex}.topbar__back{appearance:none;cursor:pointer;background:var(--surface-3);width:40px;height:40px;color:var(--text);box-shadow:none;border:0;border-radius:50%;flex:none;justify-content:center;align-items:center;margin:0;padding:0;font-size:1rem;display:inline-flex}.topbar__back:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px}.topbar__titles{flex:1;min-width:0}.topbar__title{margin:0;font-size:1.15rem;font-weight:700;line-height:1.2}.topbar__sub{color:var(--text-secondary);overflow-wrap:anywhere;margin:.1rem 0 0;font-size:.9rem}.topbar__meta{color:var(--text-secondary);white-space:nowrap;flex:none;font-size:.95rem}.flow-hero{text-align:center;padding:.5rem 0 1.4rem}.flow-hero__eyebrow{color:var(--text-secondary);margin:0;font-size:1rem}.flow-hero__headline{text-wrap:balance;margin:.35rem 0 .6rem;font-size:2rem;font-weight:700;line-height:1.1}.flow-hero__body{color:var(--text-secondary);text-wrap:balance;margin:0;font-size:1.05rem;line-height:1.45}.flow-foot{text-align:center;color:var(--text-secondary);margin:.9rem 0 0;font-size:.95rem}.flow-error{background:var(--c-hazard-bg);color:var(--c-hazard);text-align:center;border-radius:.6rem;margin:.75rem 0 0;padding:.6rem .8rem;font-size:.95rem}.flow-foot--split{text-align:left;justify-content:space-between;align-items:baseline;gap:.75rem;display:flex}.flow-foot__link{color:var(--brand-blue);cursor:pointer;font-weight:600;font:inherit;background:0 0;border:0;padding:0;font-weight:600}.flow-foot__link:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px;border-radius:4px}.view-check.check{flex-direction:column;min-height:100svh;padding-bottom:1rem;display:flex}.check__bar{justify-content:space-between;align-items:center;gap:.75rem;padding:1rem 0 .9rem;display:flex}.check__cancel,.check__skip{appearance:none;cursor:pointer;font:inherit;color:var(--brand-blue);box-shadow:none;background:0 0;border:0;align-items:center;gap:.15rem;height:auto;margin:0;padding:.2rem 0;font-weight:600;display:inline-flex}.check__cancel wa-icon{font-size:1rem}.check__place{font-size:1.05rem;font-weight:700}.check__spacer{min-width:2.5rem;display:inline-block}.check__cancel:focus-visible,.check__skip:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px;border-radius:6px}.segbar{gap:.4rem;margin-bottom:1.1rem;display:flex}.seg{border-radius:var(--radius-pill);background:var(--surface-3);flex:1;height:5px}.seg--captured{background:var(--ink)}.seg--current{background:var(--brand-blue)}.seg--skipped{border:1.5px dashed var(--text-faint);background:0 0;height:2px}.shotgrid{flex:auto;grid-template-columns:repeat(3,1fr);align-content:start;gap:.6rem;min-height:220px;margin-bottom:1rem;display:grid;overflow-y:auto}.shotgrid--empty{justify-content:center;align-items:center;display:flex}.shot{aspect-ratio:1;background:var(--surface-3);border-radius:12px;position:relative;overflow:hidden}.shot__body{appearance:none;width:100%;height:100%;color:inherit;cursor:pointer;text-align:inherit;background:0 0;border:0;margin:0;padding:0;display:block}.shot__body:focus-visible{outline:2px solid var(--brand-blue);outline-offset:-2px}.shot__img{object-fit:cover;width:100%;height:100%;display:block}.shot--description{background:var(--surface-2);border:1px solid var(--line)}.shot__body--description{color:var(--ink);flex-direction:column;justify-content:center;align-items:center;gap:.35rem;padding:.85rem;display:flex}.shot__icon{background:#ffffff0f;border-radius:999px;justify-content:center;align-items:center;width:2.25rem;height:2.25rem;font-size:1.25rem;display:inline-flex;transform:translateY(-.2rem)}.shot__label{font-size:.78rem;font-weight:700;line-height:1.15}.shot__del{appearance:none;cursor:pointer;color:#fff;width:32px;height:32px;box-shadow:none;background:#0009;border:0;border-radius:50%;justify-content:center;align-items:center;margin:0;padding:0;display:inline-flex;position:absolute;bottom:4px;right:4px}.shot__del:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px}.addshot{appearance:none;aspect-ratio:1;border:2px dashed var(--c-line);background:var(--surface-2);width:100%;height:100%;color:var(--text-secondary);cursor:pointer;font:inherit;box-shadow:none;text-align:center;border-radius:12px;flex-direction:column;justify-content:center;align-items:center;gap:.25rem;min-width:0;margin:0;padding:.4rem;display:flex;overflow:hidden}.addshot__label{font-size:.72rem;font-weight:600;line-height:1.15}.addshot__hint{color:var(--text-faint);font-size:.85rem}.addshot--empty{aspect-ratio:auto;gap:.5rem;width:min(100%,260px);height:auto;padding:2.4rem 1.5rem}.addshot--empty .addshot__label{font-size:1.05rem}.addshot:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px}.check__actions{justify-content:space-between;align-items:center;gap:1rem;padding-top:.2rem;display:flex}.check__actions--perimeter{flex-direction:column;align-items:stretch}.check__nav{justify-content:space-between;align-items:center;gap:1rem;display:flex}.check__describe{appearance:none;box-shadow:none;text-shadow:none;color:var(--ink);cursor:pointer;font:inherit;text-align:left;background:0 0;border:0;min-width:0;margin:0;padding:.35rem 0;font-size:1rem;font-weight:700;line-height:1.2}.check__actions--perimeter .check__describe{text-align:center;align-self:center}.check__describe:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px;border-radius:6px}.check__next{appearance:none;cursor:pointer;background:var(--ink);color:var(--on-ink);font:inherit;border-radius:var(--radius-pill);height:auto;box-shadow:none;border:0;flex:none;margin:0;padding:.9rem 1.1rem;font-size:1rem;font-weight:700}.check__previous{flex:none}.check__previous::part(base){border-radius:var(--radius-pill);background:var(--ink);min-height:auto;color:var(--on-ink);box-shadow:none;font:inherit;border:0;padding:.9rem 1.1rem;font-size:1rem;font-weight:700}.check__previous::part(label){line-height:1.2}.check__previous[disabled]::part(base),.check__next:disabled{opacity:.4;cursor:default}.check__next:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px}@media (width<=359px){.check__actions{flex-direction:column;align-items:stretch}.check__nav{flex-direction:column}.check__describe,.check__next,.check__previous{width:100%}.check__describe{text-align:center}}.check-timeline{--check-flow-ink:#2f323f;--check-flow-on-ink:#fff;--check-flow-text:var(--wa-color-text-normal,#1b1d26);gap:1.5rem;width:min(100%,64rem);max-width:none;min-height:100dvh;margin-inline:auto;padding-top:4rem;padding-bottom:4rem}.check-timeline button{box-shadow:none}.check-timeline__topbar{justify-content:flex-end;width:100%;display:flex}.check-timeline__close{appearance:none;border-radius:var(--radius-pill);background:var(--surface-2);width:2.6875rem;height:2.6875rem;min-height:2.6875rem;color:var(--text);cursor:pointer;box-shadow:none;text-shadow:none;border:0;justify-content:center;align-items:center;margin:0;padding:0;line-height:1;display:inline-flex}.check-timeline__close-icon{background-color:var(--ink);width:1rem;height:1rem;display:block;transform:scale(1.02);-webkit-mask-image:url(`+new URL(`icons/xmark.svg`,import.meta.url).href+`);mask-image:url(`+new URL(`icons/xmark.svg`,import.meta.url).href+`);-webkit-mask-position:50%;mask-position:50%;-webkit-mask-size:contain;mask-size:contain;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}.check-timeline__title{color:var(--text);font-family:var(--wa-font-family-heading,var(--font-sans));font-size:var(--wa-font-size-2xl,2rem);font-weight:var(--wa-font-weight-heading,600);letter-spacing:0;margin:0;line-height:1.2}.place-timeline{flex-direction:column;gap:.5rem;width:100%;display:flex}.place-row{grid-template-columns:2.75rem minmax(0,1fr);column-gap:1rem;width:100%;display:grid}.place-row__rail{flex-direction:column;align-items:center;gap:.25rem;min-height:3.25rem;display:flex}.place-row__step{border-radius:var(--radius-pill);border:2px solid var(--check-flow-ink);width:2.6875rem;min-width:2.6875rem;height:2.6875rem;min-height:2.6875rem;color:var(--check-flow-text);text-align:center;font-family:"Font Awesome 7 Pro", var(--font-sans);font-size:var(--wa-font-size-m);background:0 0;justify-content:center;align-items:center;font-style:normal;font-weight:900;line-height:1.2;display:inline-flex}.place-row__step--done,.place-row__step--skipped{background:var(--check-flow-ink);color:var(--check-flow-on-ink)}.place-row__minus{border-radius:var(--radius-pill);background:currentColor;width:.75rem;height:.125rem;display:block}.place-row__check{width:1rem;height:1rem;display:block;position:relative}.place-row__check:before{content:"";transform-origin:50%;border-bottom:.125rem solid;border-left:.125rem solid;width:.625rem;height:.375rem;position:absolute;top:47%;left:50%;transform:translate(-50%,-50%)rotate(-45deg)}.place-row__line{border-radius:var(--radius-pill);background:var(--surface-2);flex:auto;width:.25rem;min-height:2rem}.place-row__line--short{min-height:1rem}.place-row__line--done{background:var(--check-flow-ink)}.place-row__body{min-width:0;padding-bottom:2.25rem}.place-row__header{appearance:none;height:auto;min-height:auto;color:var(--check-flow-text);cursor:pointer;font-family:var(--wa-font-family-heading,var(--font-sans));font-size:var(--wa-font-size-xl);font-style:normal;font-weight:var(--wa-font-weight-heading);box-shadow:none;text-shadow:none;background:0 0;border:0;align-items:center;gap:.4rem;margin:0;padding:0;line-height:1.2;display:inline-flex}.place-row__caret{flex:none;width:1rem;height:1rem;display:inline-block;position:relative}.place-row__caret:before{content:"";border-top:.125rem solid var(--check-flow-text);border-left:.125rem solid var(--check-flow-text);width:.5rem;height:.5rem;position:absolute;top:50%;left:50%;transform:translate(-50%,-65%)rotate(225deg)}.place-row__caret--up:before{transform:translate(-50%,-35%)rotate(45deg)}.place-row__summary,.place-row__prompt{color:var(--text-secondary);font-size:var(--wa-font-size-s,.875rem);margin:.25rem 0 0;line-height:1.2}.place-row__expanded{flex-direction:column;gap:1rem;margin-top:1.25rem;display:flex;position:relative}.perimeter-photos{align-items:stretch;gap:.5rem;width:100%;padding-bottom:.25rem;display:flex;overflow-x:auto}.perimeter-photo{aspect-ratio:1;border-radius:1rem;flex:0 0 12.5rem;width:12.5rem;height:12.5rem;position:relative;overflow:visible}.perimeter-photo--add{appearance:none;background:var(--surface-2);min-height:12.5rem;color:var(--text-faint);cursor:pointer;font:inherit;box-shadow:none;text-shadow:none;border:0;flex-direction:column;justify-content:center;align-items:center;gap:1.25rem;margin:0;padding:1rem;font-weight:600;line-height:1.2;display:flex}.perimeter-photo__camera{border-radius:var(--radius-pill);background:var(--surface-3);width:3.375rem;height:3.375rem;color:var(--text);justify-content:center;align-items:center;font-size:1.25rem;display:inline-flex}.perimeter-photo--captured img{object-fit:cover;border-radius:1rem;width:100%;height:100%;display:block}.perimeter-photo__menu-button{appearance:none;border-radius:var(--radius-pill);color:#fff;cursor:pointer;width:2.375rem;min-width:2.375rem;height:2.375rem;min-height:2.375rem;box-shadow:none;text-shadow:none;background:#0003;border:0;flex:0 0 2.375rem;justify-content:center;align-items:center;margin:0;padding:0;line-height:1;display:inline-flex;position:absolute;top:1.25rem;right:1.25rem}.perimeter-photo__menu-button wa-icon{font-size:var(--wa-font-size-s,.875rem);line-height:1}.photo-menu{top:var(--photo-menu-top,3.875rem);right:var(--photo-menu-right,0);z-index:5;background:var(--surface);width:max-content;max-width:min(17.5rem,100vw - 2rem);box-shadow:var(--shadow-lift);border-radius:1rem;flex-direction:column;gap:.125rem;padding:.5rem;display:flex;position:absolute}.photo-menu button{appearance:none;border-radius:var(--radius-sm);width:100%;color:var(--text);cursor:pointer;font:inherit;text-align:left;white-space:nowrap;box-shadow:none;text-shadow:none;background:0 0;border:0;justify-content:flex-start;align-items:center;gap:.5rem;margin:0;padding:.75rem 1rem;font-size:1rem;line-height:1.2;display:flex}.photo-menu button wa-icon{flex:0 0 var(--wa-font-size-s,.875rem);width:var(--wa-font-size-s,.875rem);font-size:var(--wa-font-size-s,.875rem);text-align:center;line-height:1}.photo-menu__danger{color:var(--wa-color-danger-on-quiet,#b30532)!important}.place-row__actions,.check-timeline__footer{flex-wrap:wrap;align-items:center;gap:.5rem;display:flex}.btn-pill,.check-timeline__done,.check-timeline__analyzing{appearance:none;border-radius:var(--radius-pill);cursor:pointer;min-height:2.375rem;font:inherit;box-shadow:none;text-shadow:none;border:0;justify-content:center;align-items:center;gap:.5rem;height:auto;margin:0;padding:.55rem 1rem;font-weight:600;line-height:1.2;display:inline-flex}.place-row__actions .btn-pill{min-height:2.25rem;padding:.5rem 1rem;font-size:1rem}.btn-pill--filled{background:var(--surface-3);color:var(--text-secondary)}.btn-pill--outline{border:1px solid var(--c-line);color:var(--text-secondary);background:0 0}.btn-pill--continue,.btn-pill--save-note{background:var(--check-flow-ink);color:var(--check-flow-on-ink);font-family:var(--wa-font-family-heading,var(--font-sans));font-weight:var(--wa-font-weight-heading,600)}.btn-pill--continue:hover,.btn-pill--save-note:hover{background:color-mix(in srgb, var(--check-flow-ink) 92%, #000)}.check-timeline__done{border:2px solid var(--check-flow-text);height:2.75rem;min-height:2.75rem;color:var(--check-flow-text);background:0 0;padding:.625rem 1.125rem;font-size:1.125rem}.check-timeline .check-timeline__done{border:2px solid var(--check-flow-text)}.check-timeline__analyzing{background:var(--surface-2);height:2.75rem;min-height:2.75rem;color:var(--text-secondary);border:2px solid #0000;padding:.625rem 1.125rem;font-size:1.125rem}.check-timeline__analyzing-caret{flex:none;width:1rem;height:1rem;display:block;position:relative}.check-timeline__analyzing-caret:before{content:"";border-top:.125rem solid;border-left:.125rem solid;width:.5rem;height:.5rem;position:absolute;top:50%;left:50%;transform:translate(-50%,-65%)rotate(225deg)}.check-timeline__analyzing-caret--up:before{transform:translate(-50%,-35%)rotate(45deg)}.place-timeline__add{appearance:none;border:1px solid var(--c-line);border-radius:var(--radius-pill);width:auto;min-width:0;max-width:max-content;height:auto;min-height:2.25rem;color:var(--text-secondary);cursor:pointer;font:inherit;box-shadow:none;text-shadow:none;background:0 0;justify-content:center;align-self:flex-start;align-items:center;gap:.5rem;margin:0 0 0 .125rem;padding:.5rem 1rem;font-size:1rem;font-weight:600;line-height:1.2;display:inline-flex}.place-timeline__add-icon{width:.875rem;height:.875rem;display:block;position:relative}.place-timeline__add-icon:before,.place-timeline__add-icon:after{content:"";border-radius:var(--radius-pill);background:currentColor;width:.75rem;height:.125rem;position:absolute;top:50%;left:50%;transform:translate(-50%,-50%)}.place-timeline__add-icon:after{transform:translate(-50%,-50%)rotate(90deg)}.typed-evidence textarea{resize:vertical;border:1px solid var(--c-line);border-radius:var(--radius);background:var(--surface);width:100%;min-height:7.5rem;color:var(--text);font:inherit;padding:.75rem 1rem;font-size:1rem;line-height:1.6}.place-row__inline-ai{color:var(--text-faint);align-items:center;gap:.5rem;display:flex}.place-row__inline-ai span,.skeleton-line{border-radius:var(--radius-pill);background:var(--surface-3);height:1rem;display:block}.place-row__inline-ai span{width:7.5rem}.place-row__conditions{margin:.75rem 0 0 calc(-1 * (var(--wa-font-size-m,1rem) + .5rem));flex-direction:column;align-items:flex-start;gap:.5rem;padding:0;list-style:none;display:flex}.place-row__conditions li{color:var(--check-flow-text);font-family:var(--wa-font-family-heading,var(--font-sans));font-size:var(--wa-font-size-m,1rem);font-weight:var(--wa-font-weight-heading,600);align-items:center;gap:.5rem;display:flex}.place-row__conditions wa-icon{flex:0 0 var(--wa-font-size-m,1rem);width:var(--wa-font-size-m,1rem);color:var(--wa-color-neutral-fill-loud,#c4cad6);font-size:var(--wa-font-size-m,1rem);line-height:1}.place-row__pending-issue{color:var(--wa-color-neutral-fill-loud,#c4cad6);align-items:center;gap:.5rem;margin:.75rem 0 0;display:flex}.place-row__pending-issue wa-icon{flex:0 0 var(--wa-font-size-m,1rem);width:var(--wa-font-size-m,1rem);font-size:var(--wa-font-size-m,1rem);line-height:1}.place-row__pending-issue span{border-radius:var(--radius-pill);background:var(--surface-3);width:7.5rem;height:.75rem;display:block}.analysis-tray{flex-direction:column;gap:1rem;width:100%;margin-top:.25rem;display:flex}.analysis-tray h2{color:var(--text);font-family:var(--wa-font-family-heading,var(--font-sans));font-size:var(--wa-font-size-xl,1.5625rem);font-weight:var(--wa-font-weight-heading,600);margin:0;line-height:1.2}.analysis-tray__cards{--analysis-card-gap:.5rem;gap:var(--analysis-card-gap);background:var(--brand-blue-bg);border-radius:1.125rem;flex-direction:column;padding:.75rem;display:flex}.analysis-tray--standard .analysis-tray__cards{background:var(--surface-2)}.analysis-tray__empty{color:var(--text-secondary);font-size:var(--wa-font-size-s,.875rem);margin:0;line-height:1.4}.analysis-card{border-radius:var(--radius);background:var(--surface);align-items:center;gap:2rem;width:100%;min-width:0;padding:1rem;display:flex}.analysis-card--deleting{pointer-events:none;flex-shrink:0;grid-template-rows:1fr;min-height:0;animation:.22s ease-out forwards analysis-card-collapse;display:grid;overflow:clip}.analysis-card__deletion-clip{min-height:0;overflow:hidden}.analysis-card--deleting:only-child{--analysis-card-gap:0px}@keyframes analysis-card-collapse{0%{grid-template-rows:1fr;margin-bottom:0}to{margin-bottom:calc(-1 * var(--analysis-card-gap,0px));grid-template-rows:0fr}}.analysis-card--pending{align-items:flex-start}.analysis-card__content{flex:auto;min-width:0}.analysis-card .analysis-card__meta{color:var(--text-secondary);font-family:Roboto, var(--font-sans);text-transform:uppercase;align-items:center;gap:.5rem;margin:0 0 .53125rem;font-size:.625rem;font-style:normal;font-weight:400;line-height:.75rem;display:flex}.analysis-card__star{flex:none;width:.875rem;height:.875rem;display:block}.analysis-card h3{color:var(--brand-blue);font-size:var(--wa-font-size-l,1.25rem);margin:0 0 .5rem;font-weight:700;line-height:1.2}.analysis-card--standard h3{color:var(--text)}.analysis-card p{color:var(--text-secondary);font-size:var(--wa-font-size-s,.875rem);margin:0;line-height:1.6}.skeleton-line{margin-top:.75rem}.skeleton-line--wide{width:min(100%,19rem)}.skeleton-line--mid{width:min(100%,11.25rem)}.analysis-card__actions{align-items:center;gap:.5rem;margin-top:1rem;display:flex}.analysis-card__question{gap:.625rem;margin-top:1rem;display:grid}.analysis-card__question-category,.analysis-card__question-prompt{margin:0}.analysis-card__question-category{color:var(--muted);font-size:var(--wa-font-size-xs,.75rem);text-transform:uppercase;font-weight:700;line-height:1.2}.analysis-card__question-prompt{color:var(--text);font-size:var(--wa-font-size-s,.875rem);font-weight:700;line-height:1.35}.analysis-card__question-actions{flex-wrap:wrap;gap:.5rem;display:flex}.analysis-card__primary,.analysis-card__icon{appearance:none;border-radius:var(--radius-pill);cursor:pointer;font:inherit;box-shadow:none;text-shadow:none;border:0;justify-content:center;align-items:center;gap:.5rem;margin:0;font-weight:700;display:inline-flex}.analysis-card__primary{height:2.375rem;min-height:2.375rem;padding:0 var(--wa-form-control-padding-inline,.875rem);background:var(--wa-color-neutral-fill-loud,var(--ink));color:var(--wa-color-neutral-on-loud,var(--on-ink));font-family:Roboto, var(--font-sans);font-size:var(--wa-font-size-s,.875rem);white-space:nowrap;font-weight:500;line-height:1.2}.analysis-card__primary--escalation{color:#fff;background:#0071ec}.analysis-card__primary wa-icon{font-size:var(--wa-font-size-s,.875rem);line-height:1}.analysis-card__icon{border-radius:var(--radius-pill);background:var(--wa-color-neutral-fill-normal,var(--surface-3));width:2.375rem;min-width:2.375rem;height:2.375rem;min-height:2.375rem;color:var(--wa-color-neutral-on-normal,var(--text-secondary));flex:0 0 2.375rem;padding:0}.analysis-card__icon--danger{background:var(--wa-color-danger-fill-normal,var(--c-hazard-bg));color:var(--wa-color-danger-on-normal,var(--c-hazard))}.analysis-card__icon wa-icon{font-size:var(--wa-font-size-s,.875rem);line-height:1}.analysis-dialog{width:min(30rem,100vw - 2rem);max-width:calc(100vw - 2rem);color:var(--text);box-shadow:none;background:0 0;border:0;border-radius:1.5rem;padding:0}.analysis-dialog::backdrop{background:#00000047}.analysis-dialog__card{align-items:stretch;gap:var(--wa-space-xl,2rem);background:var(--wa-color-surface-default,var(--surface));width:100%;color:var(--wa-color-text-normal,var(--text));padding:var(--wa-space-l,1.5rem);box-shadow:var(--shadow-lift);border:0;border-radius:1.5rem;flex-direction:column;display:flex}.analysis-dialog__copy{flex-direction:column;gap:.25rem;display:flex}.analysis-dialog__title{color:var(--wa-color-text-normal,var(--text));font-family:var(--wa-font-family-heading,var(--font-sans));font-size:var(--wa-font-size-xl,1.5625rem);font-weight:var(--wa-font-weight-heading,600);margin:0;line-height:1.2}.analysis-dialog__text{color:var(--wa-color-text-quiet,var(--text-secondary));font-family:var(--wa-font-family-body,var(--font-sans));font-size:var(--wa-font-size-m,1rem);font-weight:var(--wa-font-weight-body,400);margin:0;line-height:1.6}.analysis-dialog__text span{color:#0053c0;text-underline-position:from-font;-webkit-text-decoration:underline dotted;text-decoration:underline dotted}.analysis-dialog__error{color:var(--wa-color-danger-on-quiet,#b30532);font-size:var(--wa-font-size-s,.875rem);margin:.5rem 0 0;line-height:1.4}.analysis-dialog__actions{flex-direction:column;gap:.25rem;display:flex}.analysis-dialog__button{appearance:none;border-radius:var(--wa-border-radius-pill,var(--radius-pill));width:100%;height:3.375rem;min-height:3.375rem;color:var(--wa-color-neutral-on-quiet,var(--text-secondary));cursor:pointer;font-family:var(--wa-font-family-body,var(--font-sans));font-size:var(--wa-font-size-l,1.25rem);font-weight:var(--wa-form-control-label-font-weight,500);padding:0 var(--wa-form-control-padding-inline,1.25rem);box-shadow:none;background:0 0;border:0;justify-content:center;align-items:center;line-height:1.2;display:inline-flex}.analysis-dialog__button:focus,.analysis-dialog__button:focus-visible{outline:none}.analysis-dialog__button:disabled{cursor:default;opacity:.65}.analysis-dialog__button--danger{background:var(--wa-color-danger-fill-normal,#ffdedc);color:var(--wa-color-danger-on-normal,#8a132c)}.analysis-dialog__button--success{background:var(--wa-color-success-fill-normal,#c2f2c1);color:var(--wa-color-success-on-normal,#0a5027)}.analysis-dialog__button--ink{background:var(--ink);color:var(--on-ink)}.analysis-dialog__button--danger-text{color:var(--wa-color-danger-on-quiet,#b30532)}.analysis-dialog__card--progress{align-items:center}.analysis-dialog__card--progress .analysis-dialog__title{align-self:stretch}.analysis-progress-ring{border:.25rem solid var(--wa-color-neutral-border-quiet,#e4e5e9);border-top-color:#0071ec;border-radius:50%;width:8rem;height:8rem;animation:.9s linear infinite analysis-progress-spin}@media (prefers-reduced-motion:reduce){.analysis-progress-ring{animation:none}}.analysis-edit-dialog__field{color:var(--wa-form-control-label-color,var(--text));font-family:var(--wa-font-family-body,var(--font-sans));font-size:var(--wa-font-size-m,1rem);font-weight:var(--wa-form-control-label-font-weight,500);flex-direction:column;gap:.5rem;line-height:1.2;display:flex}.analysis-edit-dialog__field textarea{resize:vertical;border:1px solid var(--wa-color-neutral-border-quiet,var(--c-line));border-radius:var(--wa-border-radius-l,var(--radius));background:var(--wa-form-control-background-color,var(--surface));width:100%;min-height:7.4375rem;color:var(--wa-color-text-normal,var(--text));font:inherit;font-weight:var(--wa-font-weight-body,400);padding:.5rem var(--wa-form-control-padding-inline,1rem);box-shadow:none;line-height:1.6}@keyframes analysis-progress-spin{to{transform:rotate(360deg)}}.analysis-card__media{border-radius:var(--radius-sm);background:var(--surface-2);flex:0 0 9.25rem;width:9.25rem;height:9.25rem;position:relative;overflow:hidden}.analysis-card__media img{object-fit:cover;width:100%;height:100%;display:block}.analysis-card__media span{border:1px solid var(--c-line);background:var(--surface-3);color:#0a5027;text-overflow:ellipsis;white-space:nowrap;border-radius:.25rem;max-width:calc(100% - 1rem);padding:.25rem .5rem;font-size:.75rem;font-weight:600;line-height:1.2;position:absolute;top:.5rem;right:.5rem;overflow:hidden}.analysis-card__media--text{color:var(--text-secondary);justify-content:center;align-items:center;font-size:2rem;display:flex}.add-place-dialog,.done-incomplete-dialog{width:min(25rem,100vw - 2rem)}.add-place-dialog__panel{width:100%}.add-place-dialog__panel,.add-place-dialog__actions,.done-incomplete-dialog__panel,.done-incomplete-dialog__actions{box-shadow:none}.add-place-dialog__actions button,.done-incomplete-dialog__actions button{width:100%;box-shadow:none;text-shadow:none;display:flex}.add-place-dialog__field{flex-direction:column;gap:.5rem;font-weight:600;display:flex}.add-place-dialog__field input{border:1px solid var(--text-faint);border-radius:var(--radius-pill);background:var(--surface);height:2.6875rem;min-height:2.6875rem;color:var(--text);font:inherit;box-shadow:none;padding:.75rem 1rem;font-weight:400}.add-place-dialog__field input.is-invalid{border-color:var(--wa-color-danger-on-quiet,#b30532);color:var(--wa-color-danger-on-quiet,#b30532)}.add-place-dialog__field small{color:var(--wa-color-danger-on-quiet,#b30532)}.add-place-dialog__field:has(.is-invalid){color:var(--wa-color-danger-on-quiet,#b30532)}#add-place-submit{background:var(--ink);color:var(--on-ink)}#add-place-submit:disabled{opacity:.45;cursor:default}.check-toast{z-index:20;border:1px solid var(--wa-color-success-border-quiet,#c2f2c1);border-radius:var(--radius);background:var(--wa-color-success-fill-quiet,#e3f9e3);width:min(26.5rem,100vw - 2rem);color:var(--text);box-shadow:var(--shadow);align-items:center;gap:1rem;padding:1rem;display:flex;position:fixed;bottom:1rem;left:50%;transform:translate(-50%)}.check-toast wa-icon{color:var(--wa-color-success-on-quiet,#036730)}.check-timeline button:not(.analysis-dialog__button):focus-visible,.typed-evidence textarea:focus-visible,.add-place-dialog input:focus-visible,.analysis-edit-dialog__field textarea:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px}@media (width<=520px){.check-timeline{width:100%;padding-top:2rem}.analysis-card{flex-direction:column-reverse;align-items:stretch;gap:1rem}.analysis-card__media{aspect-ratio:1.5;flex-basis:auto;width:100%;height:auto}}.view-describe.describe{flex-direction:column;gap:1.75rem;min-height:100dvh;padding-top:1rem;padding-bottom:2rem;display:flex}.describe__bar{grid-template-columns:auto 1fr auto;align-items:center;gap:1rem;width:min(100%,30rem);margin-inline:auto;display:grid}.describe__close{appearance:none;background:var(--surface-2);width:2.6875rem;height:2.6875rem;color:var(--ink);cursor:pointer;font:inherit;box-shadow:none;border:0;border-radius:999px;justify-content:center;align-items:center;margin:0;padding:0;display:inline-flex}.describe__close-icon{background-color:var(--ink);width:1rem;height:1rem;display:block;-webkit-mask-position:50%;mask-position:50%;-webkit-mask-size:contain;mask-size:contain;-webkit-mask-repeat:no-repeat;mask-repeat:no-repeat}.describe__close:focus-visible,.describe__continue:focus-visible,.describe-modal__secondary:focus-visible,.describe-modal__primary:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px}.describe__heading{text-align:center;min-width:0}.describe__main{flex-direction:column;flex:auto;justify-content:center;align-items:center;gap:2rem;display:flex}.describe__close-icon--back{transform:translate(-.015625rem);-webkit-mask-image:url(`+new URL(`icons/chevron-left.svg`,import.meta.url).href+`);mask-image:url(`+new URL(`icons/chevron-left.svg`,import.meta.url).href+`)}.describe__close-icon--dismiss{transform:scale(1.02);-webkit-mask-image:url(`+new URL(`icons/xmark.svg`,import.meta.url).href+`);mask-image:url(`+new URL(`icons/xmark.svg`,import.meta.url).href+`)}.describe__title{color:var(--ink);margin:0;font-size:1.5625rem;font-weight:600;line-height:1.2}.describe__subtitle{max-width:24rem;color:var(--text-secondary);text-wrap:balance;margin:.25rem auto 0;font-size:1rem;line-height:1.6}.describe__card{background:var(--surface-2);border-radius:1.5rem;flex-direction:column;gap:.625rem;width:min(100%,25.75rem);margin:0 auto;padding:.625rem 1rem 1.375rem;display:flex}.describe__field-wrap{margin-bottom:-.375rem;position:relative}.describe__field{appearance:none;resize:none;border:1px solid var(--c-line);background:var(--surface);width:100%;min-height:9.25rem;box-shadow:none;color:var(--ink);font-family:var(--wa-font-family-body);font-size:var(--wa-font-size-l);font-style:normal;font-weight:var(--wa-font-weight-body);border-radius:.75rem;padding:9px 20px;line-height:1.6}.describe__field::placeholder{color:var(--wa-form-control-placeholder-color);font-family:var(--wa-font-family-body);font-size:var(--wa-font-size-l);font-style:normal;font-weight:var(--wa-font-weight-body);line-height:1.6}.describe__field:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px}.describe__chips{flex-wrap:wrap;gap:.25rem;display:flex}.describe__meta{grid-template-columns:minmax(0,1fr) auto;align-items:center;column-gap:.875rem;margin-top:-.375rem;display:grid}.describe__clear{appearance:none;box-shadow:none;text-shadow:none;color:var(--wa-color-text-link);font-family:var(--wa-font-family-body);font-size:var(--wa-font-size-m);font-style:normal;font-weight:var(--wa-font-weight-normal);-webkit-text-decoration-skip-ink:auto;text-decoration-skip-ink:auto;text-underline-offset:auto;text-underline-position:from-font;cursor:pointer;background:0 0;border:0;border-radius:0;flex:none;align-self:center;margin:0;padding:0;line-height:1.6;text-decoration-line:underline;text-decoration-style:dotted;text-decoration-thickness:auto}.describe__clear:hover,.describe__clear:active{box-shadow:none;background:0 0}.describe__clear:disabled{visibility:hidden}.describe__clear:focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px;border-radius:.25rem}.describe-chip{border-radius:var(--radius-pill);color:#9194a2;background:#e4e5e9;border:0;justify-content:center;align-items:center;min-height:1.875rem;padding:.328rem .75rem;font-size:.875rem;font-weight:500;line-height:1.2;display:inline-flex}.describe-chip[data-complete=true]{color:#276246;background:#d9f2e3}.describe__actions{flex-direction:column;justify-content:center;align-items:center;margin-top:auto;display:flex}.describe__validation-status{visibility:visible;min-height:2.75rem;color:var(--text-secondary);text-align:center;max-width:22rem;margin:0 0 .875rem;font-size:.95rem;line-height:1.4}.describe__validation-status[aria-hidden=true]{visibility:hidden}.describe__validation-status[data-kind=error]{color:var(--c-hazard)}.describe__continue{appearance:none;border-radius:var(--radius-pill);background:var(--surface-2);color:#424554;cursor:pointer;width:auto;font:inherit;height:auto;box-shadow:none;opacity:.5;border:0;margin:0;padding:.9375rem 1.25rem;font-size:1.25rem;font-weight:500;line-height:1.2}.describe__continue:disabled{cursor:default;opacity:.5}.describe__continue:not(:disabled){background:var(--ink);color:var(--on-ink);opacity:1}.describe-modal{background:0 0;border:0;width:min(100%,28rem);padding:0}.describe-modal::backdrop{background:#00000073}.describe-modal__card{background:var(--surface-1);border-radius:22px;flex-direction:column;gap:.9rem;margin:0;padding:1.3rem;display:flex;box-shadow:0 20px 48px #0000002e}.describe-modal__title{margin:0;font-size:1.25rem;line-height:1.15}.describe-modal__text{color:var(--text-secondary);margin:0}.describe-modal__actions{flex-direction:column;gap:.65rem;display:flex}.describe-modal__secondary,.describe-modal__primary{appearance:none;border-radius:var(--radius-pill);width:100%;font:inherit;height:auto;box-shadow:none;margin:0;padding:.95rem 1rem;font-weight:700}.describe-modal__secondary{border:1px solid var(--c-line);background:var(--surface-1);color:var(--text)}.describe-modal__primary{background:var(--ink);color:var(--on-ink);border:0}@media (width<=479px){.describe__title{font-size:1.4rem}.describe__subtitle{font-size:.95rem}.describe__field{font-size:1.1rem}}.rowcard{background:var(--surface);border:1px solid var(--c-line);border-radius:16px;overflow:hidden}.rowcard__row{border-top:1px solid var(--c-line);align-items:center;gap:.9rem;padding:.9rem 1rem;display:flex}.rowcard__row:first-child{border-top:0}.rowcard__thumb{background:var(--surface-3);width:56px;height:56px;color:var(--text-faint);object-fit:cover;border-radius:12px;flex:none;justify-content:center;align-items:center;font-weight:700;display:inline-flex}.rowcard__body{flex:1;min-width:0}.rowcard__title{margin:0;font-size:1.1rem;font-weight:700}.rowcard__detail{color:var(--text-secondary);overflow-wrap:anywhere;margin:.15rem 0 0;font-size:.98rem}.rowcard__action{appearance:none;cursor:pointer;color:var(--brand-blue);font:inherit;box-shadow:none;background:0 0;border:0;flex:none;height:auto;margin:0;padding:.3rem .2rem;font-weight:600}.rowcard__action:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px;border-radius:6px}.infostrip{background:var(--surface-2);border:1px solid var(--c-line);color:var(--text-secondary);border-radius:12px;justify-content:space-between;align-items:center;gap:.75rem;margin:1.2rem 0;padding:.85rem 1rem;font-size:.98rem;display:flex}.infostrip__link{color:var(--brand-blue);white-space:nowrap;font-weight:600}.evidence{padding-bottom:1.3rem}.evidence__head{justify-content:space-between;align-items:baseline;gap:.5rem;margin-bottom:.7rem;display:flex}.evidence__label{color:var(--text-secondary);font-size:.98rem}.evidence__link{color:var(--brand-blue);font-weight:600}.evidence__strip{gap:.55rem;display:flex;overflow-x:auto}.evidence__thumb{background:var(--surface-3);object-fit:cover;border-radius:10px;flex:none;width:74px;height:60px}.evidence__thumb--active{outline:2px solid var(--brand-blue);outline-offset:-2px}.evidence__thumb--more{border:1.5px dashed var(--c-line);color:var(--text-secondary);text-align:center;background:0 0;justify-content:center;align-items:center;font-size:.85rem;display:inline-flex}.bucket{margin-top:1.4rem}.bucket__head{justify-content:space-between;align-items:baseline;gap:.5rem;margin-bottom:.6rem;display:flex}.bucket__title{font-size:1.05rem;font-weight:700}.bucket__meta{color:var(--text-secondary);font-size:.95rem}.findcard{background:var(--surface);border:1px solid var(--c-line);border-radius:16px;overflow:hidden}.findcard__row{border-top:1px solid var(--c-line);cursor:pointer;padding:1rem 1.1rem}.findcard__row:first-child{border-top:0}.findcard__head{justify-content:space-between;align-items:center;gap:.5rem;margin-bottom:.3rem;display:flex}.findcard__kicker{color:var(--text-secondary);font-size:.95rem}.findcard__title{margin:0;font-size:1.2rem;font-weight:700}.findcard__desc{color:var(--text-secondary);margin:.2rem 0 0;font-size:1rem;line-height:1.4}.findcard__prov{color:var(--text-faint);overflow-wrap:anywhere;margin:.5rem 0 0;font-size:.9rem}.checkcard{background:var(--surface);border:1px solid var(--c-line);border-radius:16px;overflow:hidden}.checkitem{border-top:1px solid var(--c-line);text-align:left;appearance:none;cursor:pointer;width:100%;font:inherit;color:inherit;box-shadow:none;background:0 0;border-left:0;border-right:0;align-items:center;gap:.9rem;height:auto;margin:0;padding:1rem 1.1rem;display:flex}.checkitem:first-child{border-top:0}.checkitem__body{flex:1;min-width:0}.checkitem__title{margin:0;font-size:1.15rem;font-weight:700}.checkitem__detail{color:var(--text-secondary);margin:.15rem 0 0;font-size:.98rem}.checkitem__ring{border:2px solid var(--c-line);border-radius:50%;flex:none;width:26px;height:26px}.checkitem[aria-pressed=true] .checkitem__ring{border-color:var(--brand-blue);background:var(--brand-blue);box-shadow:inset 0 0 0 3px var(--surface)}.checkitem:focus-visible{outline:2px solid var(--brand-blue);outline-offset:-2px}.noted{background:var(--surface);border:1px solid var(--c-line);border-radius:16px;margin-top:1.4rem;padding:1rem 1.1rem}.noted__head{color:var(--text-secondary);justify-content:space-between;align-items:baseline;gap:.5rem;margin-bottom:.5rem;display:flex}.noted__list{margin:0;padding:0;list-style:none}.noted__row{justify-content:space-between;align-items:baseline;gap:.75rem;padding:.35rem 0;display:flex}.noted__name{color:var(--text)}.noted__pct{color:var(--text-secondary);font-variant-numeric:tabular-nums}.flow-ctas{flex-direction:column;gap:.7rem;margin-top:1.5rem;display:flex}.flow-ctas .btn-ink,.flow-ctas .btn-outline{width:100%;padding-left:0;padding-right:0}.topbar--review{border-bottom:0;align-items:flex-start;margin-bottom:1rem}.topbar--review .topbar__title{font-size:1.6rem;line-height:1.15}.thumbstrip{scrollbar-width:none;padding-bottom:1.3rem;gap:.6rem;margin:0;padding-inline-start:0;list-style:none;display:flex;overflow-x:auto}.thumbstrip::-webkit-scrollbar{display:none}.thumbstrip__item{flex:none}.thumbstrip__thumb{background:var(--surface-3);object-fit:cover;border-radius:14px;width:150px;height:150px;display:block}.assess{background:var(--surface-2);border-radius:18px;padding:1.2rem 1rem 1rem}.assess__head{padding:0 .2rem .2rem}.assess__spark{color:var(--text);margin-bottom:.5rem;font-size:1.4rem;display:block}.assess__summary{text-wrap:balance;margin:0;font-size:1.3rem;font-weight:700;line-height:1.25}.assess__sub{color:var(--text-secondary);margin:.4rem 0 0;font-size:1rem}.assess__list{flex-direction:column;gap:.7rem;margin-top:1rem;display:flex}.issue{background:var(--surface);border:1px solid var(--c-line);border-radius:14px;padding:.9rem 1.1rem 1rem}.issue__title{margin:0;font-size:1.15rem;font-weight:700}.issue__places{letter-spacing:.02em;text-transform:uppercase;color:var(--text-secondary);margin:.15rem 0 0;font-size:.85rem;font-weight:600}.issue__desc{color:var(--text-secondary);overflow-wrap:anywhere;margin:.2rem 0 0;font-size:1rem;line-height:1.4}.issue__flag{appearance:none;box-shadow:none;cursor:pointer;height:auto;font:inherit;color:var(--brand-blue);background:0 0;border:0;margin:0;padding:.5rem 0 0;font-weight:600;text-decoration:underline}.issue__flag:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px;border-radius:4px}.assess .rowcard{margin-top:1rem}.issue--marked .issue__title,.issue--marked .issue__desc{color:var(--text-secondary);text-decoration:line-through}.issue__status{color:var(--c-flag);margin:.5rem 0 0;font-size:1rem;font-weight:600}.issue__undo{appearance:none;box-shadow:none;cursor:pointer;height:auto;font:inherit;color:var(--brand-blue);background:0 0;border:0;margin:0;padding:0;font-weight:600;text-decoration:underline}.issue__undo:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px;border-radius:4px}.sheet{width:min(100% - 2rem,24rem);max-width:none;color:var(--text);opacity:1;transition:opacity var(--wa-transition-normal,.15s) ease, translate var(--wa-transition-normal,.15s) ease, scale var(--wa-transition-normal,.15s) ease, overlay var(--wa-transition-normal,.15s) ease allow-discrete, display var(--wa-transition-normal,.15s) ease allow-discrete;background:0 0;border:0;margin:auto;padding:0;translate:0;scale:1}.sheet:not([open]){opacity:0;translate:0 .6rem;scale:.96}@starting-style{.sheet[open]{opacity:0;translate:0 .6rem;scale:.96}}.sheet::backdrop{transition:opacity var(--wa-transition-normal,.15s) ease, overlay var(--wa-transition-normal,.15s) ease allow-discrete, display var(--wa-transition-normal,.15s) ease allow-discrete;background:#0006}.sheet:not([open])::backdrop{opacity:0}@starting-style{.sheet[open]::backdrop{opacity:0}}@media (prefers-reduced-motion:reduce){.sheet:not([open]){translate:0;scale:1}@starting-style{.sheet[open]{translate:0;scale:1}}}.sheet__panel{background:var(--surface);box-shadow:var(--shadow-lift);border-radius:18px;width:100%;padding:1rem}.sheet__actions{flex-direction:column;gap:.6rem;display:flex}.sheet__opts{flex-direction:column;gap:.55rem;margin:.6rem 0 0;padding:0;list-style:none;display:flex}.sheet__opts li{margin:0;padding:0}.sheet__opt{width:100%;min-height:46px;color:var(--c-hazard);font:inherit;cursor:pointer;background:0 0;border:0;border-radius:999px;margin:0;font-weight:800}.sheet__cancel{background:var(--ink);width:100%;min-height:46px;color:var(--on-ink);font:inherit;cursor:pointer;border:0;border-radius:999px;margin:0;font-weight:800;display:block}.sheet__opt:focus-visible,.sheet__cancel:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px}.feedback-dialog{flex:none;display:block}.feedback__open{appearance:none;cursor:pointer;width:2.75rem;height:2.75rem;font:inherit;color:var(--text-secondary);box-shadow:none;background:0 0;border:0;border-radius:999px;justify-content:center;align-items:center;margin:0;padding:0;display:inline-flex;position:static}.feedback__open:hover,.feedback__open:not(:disabled):active{color:var(--text);background:var(--surface-3)}.feedback__open:focus-visible{outline:2px solid var(--brand-blue);outline-offset:2px}.feedback__open wa-icon{font-size:1.15rem}.feedback__panel{width:min(100vw - 2rem,24rem)}.feedback__intro{color:var(--text-secondary);margin:0 0 .7rem;font-size:.95rem;line-height:1.4}.feedback__textarea{width:100%}.feedback__textarea::part(form-control-label){font-size:.9rem;font-weight:600}.feedback__error{color:var(--danger,#b3261e);margin:.6rem 0 0;font-size:.9rem}.feedback__thanks{text-align:center;margin:.4rem 0 1rem;font-size:1.05rem;font-weight:600}.feedback__actions{justify-content:flex-end;gap:.6rem;margin-top:.9rem;display:flex}.feedback__actions .btn-ink,.feedback__actions .btn-outline{min-width:6.5rem}app-toasts{z-index:100;pointer-events:none;justify-items:center;gap:.75rem;max-block-size:100dvh;padding-block-end:.5rem;display:grid;position:fixed;inset-block-start:env(safe-area-inset-top,0px);inset-inline:0;overflow-y:auto}.app-toast{box-sizing:border-box;background:var(--surface);inline-size:min(100%,52.5rem);color:var(--text);box-shadow:var(--toast-shadow);pointer-events:auto;border-radius:0 0 1.5rem 1.5rem;align-items:center;gap:2rem;padding:1.5rem;display:flex}.app-toast__icon{flex:0 0 2.6875rem;block-size:2.6875rem;inline-size:2.6875rem;font-size:2rem}.app-toast--success .app-toast__icon{color:var(--toast-success)}.app-toast--error .app-toast__icon{color:var(--c-hazard)}.app-toast__copy{overflow-wrap:anywhere;flex:1;min-inline-size:0}.app-toast__title{margin:0 0 .25rem;font-size:1.5625rem;font-weight:600;line-height:1.2}.app-toast__message{color:var(--text-secondary);margin:0;font-size:1rem;line-height:1.6}.app-toast a{color:var(--brand-blue);text-underline-offset:.2em;-webkit-text-decoration:underline dotted;text-decoration:underline dotted}.app-toast__controls{flex:none;align-items:center;gap:.75rem;display:flex}.app-toast button{height:auto;box-shadow:none;min-block-size:2.75rem;min-inline-size:2.75rem;color:var(--text-secondary);cursor:pointer;background:0 0;border:0;border-radius:.375rem;justify-content:center;align-items:center;margin:0;padding:.75rem;font-family:inherit;font-weight:500;line-height:1.2;display:inline-flex}.app-toast button:hover{background:var(--surface-2)}.app-toast .app-toast__undo{padding-inline:1.25rem;font-size:1.25rem}.app-toast .app-toast__close{border-inline-start:1px solid var(--c-line);border-radius:0}.app-toast :is(a,button):focus-visible{outline:2px solid var(--brand-blue);outline-offset:3px}@media (width<=40rem){.app-toast{grid-template-columns:2.6875rem minmax(0,1fr) auto;align-items:start;gap:.75rem;padding:1rem;display:grid}.app-toast__controls{flex-direction:column-reverse;gap:.25rem}.app-toast .app-toast__undo{padding-inline:.25rem;font-size:1rem}}`,mn=`body{background:var(--bg);color:var(--text);font-family:var(--font-sans);flex-direction:column;align-items:center;gap:1.25rem;margin:0;padding:2rem 1rem;display:flex}.story-row{flex-wrap:wrap;justify-content:center;align-items:center;gap:.75rem;display:flex}.story-stack{flex-direction:column;align-items:center;gap:.6rem;display:flex}.story-label{letter-spacing:.05em;text-transform:uppercase;color:var(--text-faint);margin:0;font-size:.75rem;font-weight:700}.story-theme-wrap{border:1px solid var(--c-line);border-radius:14px;flex-direction:column;gap:.75rem;padding:1.25rem;display:flex}.show-a11y-outlines :is(button,a,input,textarea,select,[tabindex]):focus{outline:3px solid var(--brand-blue)!important;outline-offset:3px!important}`,hn=``,gn=``;function _n(){return hn.replace(/\/$/,``)}function vn(e){gn=e}function yn(){if(!gn){let e=document.querySelector(`[data-fa-kit-code]`);e&&vn(e.getAttribute(`data-fa-kit-code`)||``)}return gn}var bn=`7.3.0`;function xn(e,t,n){let r=`solid`;return t===`chisel`&&(r=`chisel-regular`),t===`etch`&&(r=`etch-solid`),t===`graphite`&&(r=`graphite-thin`),t===`jelly`&&(r=`jelly-regular`,n===`duo-regular`&&(r=`jelly-duo-regular`),n===`fill-regular`&&(r=`jelly-fill-regular`)),t===`jelly-duo`&&(r=`jelly-duo-regular`),t===`jelly-fill`&&(r=`jelly-fill-regular`),t===`notdog`&&(n===`solid`&&(r=`notdog-solid`),n===`duo-solid`&&(r=`notdog-duo-solid`)),t===`notdog-duo`&&(r=`notdog-duo-solid`),t===`slab`&&((n===`solid`||n===`regular`)&&(r=`slab-regular`),n===`press-regular`&&(r=`slab-press-regular`)),t===`slab-press`&&(r=`slab-press-regular`),t===`slab-duo`&&(r=`slab-duo-regular`),t===`slab-press-duo`&&(r=`slab-press-duo-regular`),t===`thumbprint`&&(r=`thumbprint-light`),t===`utility`&&(r=`utility-semibold`),t===`utility-duo`&&(r=`utility-duo-semibold`),t===`utility-fill`&&(r=`utility-fill-semibold`),t===`whiteboard`&&(r=`whiteboard-semibold`),t===`mosaic`&&(r=`mosaic-solid`),t===`pixel`&&(r=`pixel-regular`),t===`vellum`&&(r=`vellum-solid`),t===`classic`&&(n===`thin`&&(r=`thin`),n===`light`&&(r=`light`),n===`regular`&&(r=`regular`),n===`solid`&&(r=`solid`)),t===`duotone`&&(n===`thin`&&(r=`duotone-thin`),n===`light`&&(r=`duotone-light`),n===`regular`&&(r=`duotone-regular`),n===`solid`&&(r=`duotone`)),t===`sharp`&&(n===`thin`&&(r=`sharp-thin`),n===`light`&&(r=`sharp-light`),n===`regular`&&(r=`sharp-regular`),n===`solid`&&(r=`sharp-solid`)),t===`sharp-duotone`&&(n===`thin`&&(r=`sharp-duotone-thin`),n===`light`&&(r=`sharp-duotone-light`),n===`regular`&&(r=`sharp-duotone-regular`),n===`solid`&&(r=`sharp-duotone-solid`)),t===`brands`&&(r=`brands`),r}function Sn(e,t,n){let r=xn(e,t,n),i=_n();if(i)return`${i}/${r}/${e}.svg`;let a=yn();return a.length>0?`https://ka-p.fontawesome.com/releases/v${bn}/svgs/${r}/${e}.svg?token=${encodeURIComponent(a)}`:`https://ka-f.fontawesome.com/releases/v${bn}/svgs/${r}/${e}.svg`}var Cn={name:`default`,resolver:(e,t=`classic`,n=`solid`)=>Sn(e,t,n),mutator:(e,t)=>{if(e.hasAttribute(`fill`)||e.setAttribute(`fill`,`currentColor`),t?.family&&!e.hasAttribute(`data-duotone-initialized`)){let{family:n,variant:r}=t;if(n===`duotone`||n===`sharp-duotone`||n===`notdog-duo`||n===`notdog`&&r===`duo-solid`||n===`jelly-duo`||n===`jelly`&&r===`duo-regular`||n===`utility-duo`||n===`slab-duo`||n===`slab-press-duo`||n===`thumbprint`){let n=[...e.querySelectorAll(`path`)],r=n.find(e=>!e.hasAttribute(`opacity`)),i=n.find(e=>e.hasAttribute(`opacity`));if(!r||!i)return;if(r.setAttribute(`data-duotone-primary`,``),i.setAttribute(`data-duotone-secondary`,``),t.swapOpacity&&r&&i){let e=i.getAttribute(`opacity`)||`0.4`;r.style.setProperty(`--path-opacity`,e),i.style.setProperty(`--path-opacity`,`1`)}e.setAttribute(`data-duotone-initialized`,``)}}}};function wn(e){return`data:image/svg+xml,${encodeURIComponent(e)}`}var Tn={solid:{backward:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M236.3 107.1C247.9 96 265 92.9 279.7 99.2C294.4 105.5 304 120 304 136L304 272.3L476.3 107.2C487.9 96 505 92.9 519.7 99.2C534.4 105.5 544 120 544 136L544 504C544 520 534.4 534.5 519.7 540.8C505 547.1 487.9 544 476.3 532.9L304 367.7L304 504C304 520 294.4 534.5 279.7 540.8C265 547.1 247.9 544 236.3 532.9L44.3 348.9C36.5 341.3 32 330.9 32 320C32 309.1 36.5 298.7 44.3 291.1L236.3 107.1z"/></svg>`,"backward-step":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M491 100.8C478.1 93.8 462.3 94.5 450 102.6L192 272.1L192 128C192 110.3 177.7 96 160 96C142.3 96 128 110.3 128 128L128 512C128 529.7 142.3 544 160 544C177.7 544 192 529.7 192 512L192 367.9L450 537.5C462.3 545.6 478 546.3 491 539.3C504 532.3 512 518.8 512 504.1L512 136.1C512 121.4 503.9 107.9 491 100.9z"/></svg>`,"angles-left":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M77.3 256 214.7 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-160 160c-12.5 12.5-12.5 32.8 0 45.3l160 160c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L77.3 256zm192 0L406.7 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-160 160c-12.5 12.5-12.5 32.8 0 45.3l160 160c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L269.3 256z"/></svg>`,"angles-right":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M434.7 256 297.3 118.6c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l160 160c12.5 12.5 12.5 32.8 0 45.3l-160 160c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L434.7 256zm-192 0L105.3 118.6c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l160 160c12.5 12.5 12.5 32.8 0 45.3l-160 160c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L242.7 256z"/></svg>`,check:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M434.8 70.1c14.3 10.4 17.5 30.4 7.1 44.7l-256 352c-5.5 7.6-14 12.3-23.4 13.1s-18.5-2.7-25.1-9.3l-128-128c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l101.5 101.5 234-321.7c10.4-14.3 30.4-17.5 44.7-7.1z"/></svg>`,"chevron-down":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M201.4 406.6c12.5 12.5 32.8 12.5 45.3 0l192-192c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L224 338.7 54.6 169.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l192 192z"/></svg>`,"chevron-left":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M9.4 233.4c-12.5 12.5-12.5 32.8 0 45.3l192 192c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L77.3 256 246.6 86.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0l-192 192z"/></svg>`,"chevron-right":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M311.1 233.4c12.5 12.5 12.5 32.8 0 45.3l-192 192c-12.5 12.5-32.8 12.5-45.3 0s-12.5-32.8 0-45.3L243.2 256 73.9 86.6c-12.5-12.5-12.5-32.8 0-45.3s32.8-12.5 45.3 0l192 192z"/></svg>`,circle:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M0 256a256 256 0 1 1 512 0 256 256 0 1 1 -512 0z"/></svg>`,"closed-captioning":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M64 192C64 156.7 92.7 128 128 128L512 128C547.3 128 576 156.7 576 192L576 448C576 483.3 547.3 512 512 512L128 512C92.7 512 64 483.3 64 448L64 192zM216 272L248 272C252.4 272 256 275.6 256 280C256 293.3 266.7 304 280 304C293.3 304 304 293.3 304 280C304 249.1 278.9 224 248 224L216 224C185.1 224 160 249.1 160 280L160 360C160 390.9 185.1 416 216 416L248 416C278.9 416 304 390.9 304 360C304 346.7 293.3 336 280 336C266.7 336 256 346.7 256 360C256 364.4 252.4 368 248 368L216 368C211.6 368 208 364.4 208 360L208 280C208 275.6 211.6 272 216 272zM384 280C384 275.6 387.6 272 392 272L424 272C428.4 272 432 275.6 432 280C432 293.3 442.7 304 456 304C469.3 304 480 293.3 480 280C480 249.1 454.9 224 424 224L392 224C361.1 224 336 249.1 336 280L336 360C336 390.9 361.1 416 392 416L424 416C454.9 416 480 390.9 480 360C480 346.7 469.3 336 456 336C442.7 336 432 346.7 432 360C432 364.4 428.4 368 424 368L392 368C387.6 368 384 364.4 384 360L384 280z"/></svg>`,"closed-captioning-slash":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M39 39.1C48.4 29.7 63.6 29.7 72.9 39.1L161.8 128L512 128C547.3 128 576 156.7 576 192L576 448C576 473.5 561.1 495.4 539.6 505.8L601 567.1C610.4 576.5 610.4 591.7 601 601C591.6 610.3 576.4 610.4 567.1 601L39 73.1C29.7 63.7 29.7 48.5 39 39.1zM384 350.1L384 279.9C384 275.5 387.6 271.9 392 271.9L424 271.9C428.4 271.9 432 275.5 432 279.9C432 293.2 442.7 303.9 456 303.9C469.3 303.9 480 293.2 480 279.9C480 249 454.9 223.9 424 223.9L392 223.9C361.1 223.9 336 249 336 279.9L336 302.1L384 350.1zM445.5 411.6C465.7 403.2 480 383.2 480 359.9C480 346.6 469.3 335.9 456 335.9C442.7 335.9 432 346.6 432 359.9C432 364.3 428.4 367.9 424 367.9L401.8 367.9L445.5 411.6zM162.3 264.1C160.8 269.1 160 274.5 160 280L160 360C160 390.9 185.1 416 216 416L248 416C266.1 416 282.1 407.5 292.4 394.2L410.2 512L128 512C92.7 512 64 483.3 64 448L64 192C64 184.2 65.4 176.7 68 169.8L162.3 264.1zM256.1 357.9C256 358.6 256 359.3 256 360C256 364.4 252.4 368 248 368L216 368C211.6 368 208 364.4 208 360L208 309.8L256.1 357.9z"/></svg>`,compress:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M160 64c0-17.7-14.3-32-32-32S96 46.3 96 64l0 64-64 0c-17.7 0-32 14.3-32 32s14.3 32 32 32l96 0c17.7 0 32-14.3 32-32l0-96zM32 320c-17.7 0-32 14.3-32 32s14.3 32 32 32l64 0 0 64c0 17.7 14.3 32 32 32s32-14.3 32-32l0-96c0-17.7-14.3-32-32-32l-96 0zM352 64c0-17.7-14.3-32-32-32s-32 14.3-32 32l0 96c0 17.7 14.3 32 32 32l96 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-64 0 0-64zM320 320c-17.7 0-32 14.3-32 32l0 96c0 17.7 14.3 32 32 32s32-14.3 32-32l0-64 64 0c17.7 0 32-14.3 32-32s-14.3-32-32-32l-96 0z"/></svg>`,ellipsis:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.3.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M96 320C96 289.1 121.1 264 152 264C182.9 264 208 289.1 208 320C208 350.9 182.9 376 152 376C121.1 376 96 350.9 96 320zM264 320C264 289.1 289.1 264 320 264C350.9 264 376 289.1 376 320C376 350.9 350.9 376 320 376C289.1 376 264 350.9 264 320zM488 264C518.9 264 544 289.1 544 320C544 350.9 518.9 376 488 376C457.1 376 432 350.9 432 320C432 289.1 457.1 264 488 264z"/></svg>`,"ellipsis-vertical":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M320 208C289.1 208 264 182.9 264 152C264 121.1 289.1 96 320 96C350.9 96 376 121.1 376 152C376 182.9 350.9 208 320 208zM320 432C350.9 432 376 457.1 376 488C376 518.9 350.9 544 320 544C289.1 544 264 518.9 264 488C264 457.1 289.1 432 320 432zM376 320C376 350.9 350.9 376 320 376C289.1 376 264 350.9 264 320C264 289.1 289.1 264 320 264C350.9 264 376 289.1 376 320z"/></svg>`,expand:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 96C110.3 96 96 110.3 96 128L96 224C96 241.7 110.3 256 128 256C145.7 256 160 241.7 160 224L160 160L224 160C241.7 160 256 145.7 256 128C256 110.3 241.7 96 224 96L128 96zM160 416C160 398.3 145.7 384 128 384C110.3 384 96 398.3 96 416L96 512C96 529.7 110.3 544 128 544L224 544C241.7 544 256 529.7 256 512C256 494.3 241.7 480 224 480L160 480L160 416zM416 96C398.3 96 384 110.3 384 128C384 145.7 398.3 160 416 160L480 160L480 224C480 241.7 494.3 256 512 256C529.7 256 544 241.7 544 224L544 128C544 110.3 529.7 96 512 96L416 96zM544 416C544 398.3 529.7 384 512 384C494.3 384 480 398.3 480 416L480 480L416 480C398.3 480 384 494.3 384 512C384 529.7 398.3 544 416 544L512 544C529.7 544 544 529.7 544 512L544 416z"/></svg>`,eyedropper:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M341.6 29.2l-101.6 101.6-9.4-9.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3l160 160c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3l-9.4-9.4 101.6-101.6c39-39 39-102.2 0-141.1s-102.2-39-141.1 0zM55.4 323.3c-15 15-23.4 35.4-23.4 56.6l0 42.4-26.6 39.9c-8.5 12.7-6.8 29.6 4 40.4s27.7 12.5 40.4 4l39.9-26.6 42.4 0c21.2 0 41.6-8.4 56.6-23.4l109.4-109.4-45.3-45.3-109.4 109.4c-3 3-7.1 4.7-11.3 4.7l-36.1 0 0-36.1c0-4.2 1.7-8.3 4.7-11.3l109.4-109.4-45.3-45.3-109.4 109.4z"/></svg>`,forward:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M403.7 107.1C392.1 96 375 92.9 360.3 99.2C345.6 105.5 336 120 336 136L336 272.3L163.7 107.2C152.1 96 135 92.9 120.3 99.2C105.6 105.5 96 120 96 136L96 504C96 520 105.6 534.5 120.3 540.8C135 547.1 152.1 544 163.7 532.9L336 367.7L336 504C336 520 345.6 534.5 360.3 540.8C375 547.1 392.1 544 403.7 532.9L595.7 348.9C603.6 341.4 608 330.9 608 320C608 309.1 603.5 298.7 595.7 291.1L403.7 107.1z"/></svg>`,file:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M192 64C156.7 64 128 92.7 128 128L128 512C128 547.3 156.7 576 192 576L448 576C483.3 576 512 547.3 512 512L512 234.5C512 217.5 505.3 201.2 493.3 189.2L386.7 82.7C374.7 70.7 358.5 64 341.5 64L192 64zM453.5 240L360 240C346.7 240 336 229.3 336 216L336 122.5L453.5 240z"/></svg>`,"file-audio":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM389.8 307.7C380.7 301.4 368.3 303.6 362 312.7C355.7 321.8 357.9 334.2 367 340.5C390.9 357.2 406.4 384.8 406.4 416C406.4 447.2 390.8 474.9 367 491.5C357.9 497.8 355.7 510.3 362 519.3C368.3 528.3 380.8 530.6 389.8 524.3C423.9 500.5 446.4 460.8 446.4 416C446.4 371.2 424 331.5 389.8 307.7zM208 376C199.2 376 192 383.2 192 392L192 440C192 448.8 199.2 456 208 456L232 456L259.2 490C262.2 493.8 266.8 496 271.7 496L272 496C280.8 496 288 488.8 288 480L288 352C288 343.2 280.8 336 272 336L271.7 336C266.8 336 262.2 338.2 259.2 342L232 376L208 376zM336 448.2C336 458.9 346.5 466.4 354.9 459.8C367.8 449.5 376 433.7 376 416C376 398.3 367.8 382.5 354.9 372.2C346.5 365.5 336 373.1 336 383.8L336 448.3z"/></svg>`,"file-code":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM282.2 359.6C290.8 349.5 289.7 334.4 279.6 325.8C269.5 317.2 254.4 318.3 245.8 328.4L197.8 384.4C190.1 393.4 190.1 406.6 197.8 415.6L245.8 471.6C254.4 481.7 269.6 482.8 279.6 474.2C289.6 465.6 290.8 450.4 282.2 440.4L247.6 400L282.2 359.6zM394.2 328.4C385.6 318.3 370.4 317.2 360.4 325.8C350.4 334.4 349.2 349.6 357.8 359.6L392.4 400L357.8 440.4C349.2 450.5 350.3 465.6 360.4 474.2C370.5 482.8 385.6 481.7 394.2 471.6L442.2 415.6C449.9 406.6 449.9 393.4 442.2 384.4L394.2 328.4z"/></svg>`,"file-excel":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM292 330.7C284.6 319.7 269.7 316.7 258.7 324C247.7 331.3 244.7 346.3 252 357.3L291.2 416L252 474.7C244.6 485.7 247.6 500.6 258.7 508C269.8 515.4 284.6 512.4 292 501.3L320 459.3L348 501.3C355.4 512.3 370.3 515.3 381.3 508C392.3 500.7 395.3 485.7 388 474.7L348.8 416L388 357.3C395.4 346.3 392.4 331.4 381.3 324C370.2 316.6 355.4 319.6 348 330.7L320 372.7L292 330.7z"/></svg>`,"file-image":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM256 320C256 302.3 241.7 288 224 288C206.3 288 192 302.3 192 320C192 337.7 206.3 352 224 352C241.7 352 256 337.7 256 320zM220.6 512L419.4 512C435.2 512 448 499.2 448 483.4C448 476.1 445.2 469 440.1 463.7L343.3 361.9C337.3 355.6 328.9 352 320.1 352L319.8 352C311 352 302.7 355.6 296.6 361.9L199.9 463.7C194.8 469 192 476.1 192 483.4C192 499.2 204.8 512 220.6 512z"/></svg>`,"file-pdf":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 64C92.7 64 64 92.7 64 128L64 512C64 547.3 92.7 576 128 576L208 576L208 464C208 428.7 236.7 400 272 400L448 400L448 234.5C448 217.5 441.3 201.2 429.3 189.2L322.7 82.7C310.7 70.7 294.5 64 277.5 64L128 64zM389.5 240L296 240C282.7 240 272 229.3 272 216L272 122.5L389.5 240zM272 444C261 444 252 453 252 464L252 592C252 603 261 612 272 612C283 612 292 603 292 592L292 564L304 564C337.1 564 364 537.1 364 504C364 470.9 337.1 444 304 444L272 444zM304 524L292 524L292 484L304 484C315 484 324 493 324 504C324 515 315 524 304 524zM400 444C389 444 380 453 380 464L380 592C380 603 389 612 400 612L432 612C460.7 612 484 588.7 484 560L484 496C484 467.3 460.7 444 432 444L400 444zM420 572L420 484L432 484C438.6 484 444 489.4 444 496L444 560C444 566.6 438.6 572 432 572L420 572zM508 464L508 592C508 603 517 612 528 612C539 612 548 603 548 592L548 548L576 548C587 548 596 539 596 528C596 517 587 508 576 508L548 508L548 484L576 484C587 484 596 475 596 464C596 453 587 444 576 444L528 444C517 444 508 453 508 464z"/></svg>`,"file-powerpoint":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM280 320C266.7 320 256 330.7 256 344L256 488C256 501.3 266.7 512 280 512C293.3 512 304 501.3 304 488L304 464L328 464C367.8 464 400 431.8 400 392C400 352.2 367.8 320 328 320L280 320zM328 416L304 416L304 368L328 368C341.3 368 352 378.7 352 392C352 405.3 341.3 416 328 416z"/></svg>`,"file-video":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM208 368L208 464C208 481.7 222.3 496 240 496L336 496C353.7 496 368 481.7 368 464L368 440L403 475C406.2 478.2 410.5 480 415 480C424.4 480 432 472.4 432 463L432 368.9C432 359.5 424.4 351.9 415 351.9C410.5 351.9 406.2 353.7 403 356.9L368 391.9L368 367.9C368 350.2 353.7 335.9 336 335.9L240 335.9C222.3 335.9 208 350.2 208 367.9z"/></svg>`,"file-word":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM263.4 338.8C260.5 325.9 247.7 317.7 234.8 320.6C221.9 323.5 213.7 336.3 216.6 349.2L248.6 493.2C250.9 503.7 260 511.4 270.8 512C281.6 512.6 291.4 505.9 294.8 495.6L320 419.9L345.2 495.6C348.6 505.8 358.4 512.5 369.2 512C380 511.5 389.1 503.8 391.4 493.2L423.4 349.2C426.3 336.3 418.1 323.4 405.2 320.6C392.3 317.8 379.4 325.9 376.6 338.8L363.4 398.2L342.8 336.4C339.5 326.6 330.4 320 320 320C309.6 320 300.5 326.6 297.2 336.4L276.6 398.2L263.4 338.8z"/></svg>`,"file-zipper":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M128 128C128 92.7 156.7 64 192 64L341.5 64C358.5 64 374.8 70.7 386.8 82.7L493.3 189.3C505.3 201.3 512 217.6 512 234.6L512 512C512 547.3 483.3 576 448 576L192 576C156.7 576 128 547.3 128 512L128 128zM336 122.5L336 216C336 229.3 346.7 240 360 240L453.5 240L336 122.5zM192 136C192 149.3 202.7 160 216 160L264 160C277.3 160 288 149.3 288 136C288 122.7 277.3 112 264 112L216 112C202.7 112 192 122.7 192 136zM192 232C192 245.3 202.7 256 216 256L264 256C277.3 256 288 245.3 288 232C288 218.7 277.3 208 264 208L216 208C202.7 208 192 218.7 192 232zM256 304L224 304C206.3 304 192 318.3 192 336L192 384C192 410.5 213.5 432 240 432C266.5 432 288 410.5 288 384L288 336C288 318.3 273.7 304 256 304zM240 368C248.8 368 256 375.2 256 384C256 392.8 248.8 400 240 400C231.2 400 224 392.8 224 384C224 375.2 231.2 368 240 368z"/></svg>`,"forward-step":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M21 36.8c12.9-7 28.7-6.3 41 1.8L320 208.1 320 64c0-17.7 14.3-32 32-32s32 14.3 32 32l0 384c0 17.7-14.3 32-32 32s-32-14.3-32-32l0-144.1-258 169.6c-12.3 8.1-28 8.8-41 1.8S0 454.7 0 440L0 72C0 57.3 8.1 43.8 21 36.8z"/></svg>`,gauge:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M0 256a256 256 0 1 1 512 0 256 256 0 1 1 -512 0zm320 96c0-26.9-16.5-49.9-40-59.3L280 120c0-13.3-10.7-24-24-24s-24 10.7-24 24l0 172.7c-23.5 9.5-40 32.5-40 59.3 0 35.3 28.7 64 64 64s64-28.7 64-64zM144 176a32 32 0 1 0 0-64 32 32 0 1 0 0 64zm-16 80a32 32 0 1 0 -64 0 32 32 0 1 0 64 0zm288 32a32 32 0 1 0 0-64 32 32 0 1 0 0 64zM400 144a32 32 0 1 0 -64 0 32 32 0 1 0 64 0z"/></svg>`,gear:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M259.1 73.5C262.1 58.7 275.2 48 290.4 48L350.2 48C365.4 48 378.5 58.7 381.5 73.5L396 143.5C410.1 149.5 423.3 157.2 435.3 166.3L503.1 143.8C517.5 139 533.3 145 540.9 158.2L570.8 210C578.4 223.2 575.7 239.8 564.3 249.9L511 297.3C511.9 304.7 512.3 312.3 512.3 320C512.3 327.7 511.8 335.3 511 342.7L564.4 390.2C575.8 400.3 578.4 417 570.9 430.1L541 481.9C533.4 495 517.6 501.1 503.2 496.3L435.4 473.8C423.3 482.9 410.1 490.5 396.1 496.6L381.7 566.5C378.6 581.4 365.5 592 350.4 592L290.6 592C275.4 592 262.3 581.3 259.3 566.5L244.9 496.6C230.8 490.6 217.7 482.9 205.6 473.8L137.5 496.3C123.1 501.1 107.3 495.1 99.7 481.9L69.8 430.1C62.2 416.9 64.9 400.3 76.3 390.2L129.7 342.7C128.8 335.3 128.4 327.7 128.4 320C128.4 312.3 128.9 304.7 129.7 297.3L76.3 249.8C64.9 239.7 62.3 223 69.8 209.9L99.7 158.1C107.3 144.9 123.1 138.9 137.5 143.7L205.3 166.2C217.4 157.1 230.6 149.5 244.6 143.4L259.1 73.5zM320.3 400C364.5 399.8 400.2 363.9 400 319.7C399.8 275.5 363.9 239.8 319.7 240C275.5 240.2 239.8 276.1 240 320.3C240.2 364.5 276.1 400.2 320.3 400z"/></svg>`,"grip-vertical":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M128 40c0-22.1-17.9-40-40-40L40 0C17.9 0 0 17.9 0 40L0 88c0 22.1 17.9 40 40 40l48 0c22.1 0 40-17.9 40-40l0-48zm0 192c0-22.1-17.9-40-40-40l-48 0c-22.1 0-40 17.9-40 40l0 48c0 22.1 17.9 40 40 40l48 0c22.1 0 40-17.9 40-40l0-48zM0 424l0 48c0 22.1 17.9 40 40 40l48 0c22.1 0 40-17.9 40-40l0-48c0-22.1-17.9-40-40-40l-48 0c-22.1 0-40 17.9-40 40zM320 40c0-22.1-17.9-40-40-40L232 0c-22.1 0-40 17.9-40 40l0 48c0 22.1 17.9 40 40 40l48 0c22.1 0 40-17.9 40-40l0-48zM192 232l0 48c0 22.1 17.9 40 40 40l48 0c22.1 0 40-17.9 40-40l0-48c0-22.1-17.9-40-40-40l-48 0c-22.1 0-40 17.9-40 40zM320 424c0-22.1-17.9-40-40-40l-48 0c-22.1 0-40 17.9-40 40l0 48c0 22.1 17.9 40 40 40l48 0c22.1 0 40-17.9 40-40l0-48z"/></svg>`,indeterminate:`<svg part="indeterminate-icon" class="icon" viewBox="0 0 16 16"><g stroke="none" stroke-width="1" fill="none" fill-rule="evenodd" stroke-linecap="round"><g stroke="currentColor" stroke-width="2"><g transform="translate(2.285714 6.857143)"><path d="M10.2857143,1.14285714 L1.14285714,1.14285714"/></g></g></g></svg>`,minus:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M0 256c0-17.7 14.3-32 32-32l384 0c17.7 0 32 14.3 32 32s-14.3 32-32 32L32 288c-17.7 0-32-14.3-32-32z"/></svg>`,pause:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M48 32C21.5 32 0 53.5 0 80L0 432c0 26.5 21.5 48 48 48l64 0c26.5 0 48-21.5 48-48l0-352c0-26.5-21.5-48-48-48L48 32zm224 0c-26.5 0-48 21.5-48 48l0 352c0 26.5 21.5 48 48 48l64 0c26.5 0 48-21.5 48-48l0-352c0-26.5-21.5-48-48-48l-64 0z"/></svg>`,"picture-in-picture":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M448 32c35.3 0 64 28.7 64 64l0 112-64 0 0-112-384 0 0 320 144 0 0 64-144 0-6.5-.3c-30.1-3.1-54.1-27-57.1-57.1L0 416 0 96C0 62.9 25.2 35.6 57.5 32.3L64 32 448 32zm16 224c26.5 0 48 21.5 48 48l0 128c0 26.5-21.5 48-48 48l-160 0c-26.5 0-48-21.5-48-48l0-128c0-26.5 21.5-48 48-48l160 0z"/></svg>`,play:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M91.2 36.9c-12.4-6.8-27.4-6.5-39.6 .7S32 57.9 32 72l0 368c0 14.1 7.5 27.2 19.6 34.4s27.2 7.5 39.6 .7l336-184c12.8-7 20.8-20.5 20.8-35.1s-8-28.1-20.8-35.1l-336-184z"/></svg>`,"play-circle":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M0 256a256 256 0 1 1 512 0 256 256 0 1 1 -512 0zM188.3 147.1c-7.6 4.2-12.3 12.3-12.3 20.9l0 176c0 8.7 4.7 16.7 12.3 20.9s16.8 4.1 24.3-.5l144-88c7.1-4.4 11.5-12.1 11.5-20.5s-4.4-16.1-11.5-20.5l-144-88c-7.4-4.5-16.7-4.7-24.3-.5z"/></svg>`,plus:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M352 128C352 110.3 337.7 96 320 96C302.3 96 288 110.3 288 128L288 288L128 288C110.3 288 96 302.3 96 320C96 337.7 110.3 352 128 352L288 352L288 512C288 529.7 302.3 544 320 544C337.7 544 352 529.7 352 512L352 352L512 352C529.7 352 544 337.7 544 320C544 302.3 529.7 288 512 288L352 288L352 128z"/></svg>`,star:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M309.5-18.9c-4.1-8-12.4-13.1-21.4-13.1s-17.3 5.1-21.4 13.1L193.1 125.3 33.2 150.7c-8.9 1.4-16.3 7.7-19.1 16.3s-.5 18 5.8 24.4l114.4 114.5-25.2 159.9c-1.4 8.9 2.3 17.9 9.6 23.2s16.9 6.1 25 2L288.1 417.6 432.4 491c8 4.1 17.7 3.3 25-2s11-14.2 9.6-23.2L441.7 305.9 556.1 191.4c6.4-6.4 8.6-15.8 5.8-24.4s-10.1-14.9-19.1-16.3L383 125.3 309.5-18.9z"/></svg>`,upload:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free 7.1.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M352 173.3L352 384C352 401.7 337.7 416 320 416C302.3 416 288 401.7 288 384L288 173.3L246.6 214.7C234.1 227.2 213.8 227.2 201.3 214.7C188.8 202.2 188.8 181.9 201.3 169.4L297.3 73.4C309.8 60.9 330.1 60.9 342.6 73.4L438.6 169.4C451.1 181.9 451.1 202.2 438.6 214.7C426.1 227.2 405.8 227.2 393.3 214.7L352 173.3zM320 464C364.2 464 400 428.2 400 384L480 384C515.3 384 544 412.7 544 448L544 480C544 515.3 515.3 544 480 544L160 544C124.7 544 96 515.3 96 480L96 448C96 412.7 124.7 384 160 384L240 384C240 428.2 275.8 464 320 464zM464 488C477.3 488 488 477.3 488 464C488 450.7 477.3 440 464 440C450.7 440 440 450.7 440 464C440 477.3 450.7 488 464 488z"/></svg>`,user:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M224 248a120 120 0 1 0 0-240 120 120 0 1 0 0 240zm-29.7 56C95.8 304 16 383.8 16 482.3 16 498.7 29.3 512 45.7 512l356.6 0c16.4 0 29.7-13.3 29.7-29.7 0-98.5-79.8-178.3-178.3-178.3l-59.4 0z"/></svg>`,volume:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M48 352l48 0 134.1 119.2c6.4 5.7 14.6 8.8 23.1 8.8 19.2 0 34.8-15.6 34.8-34.8l0-378.4c0-19.2-15.6-34.8-34.8-34.8-8.5 0-16.7 3.1-23.1 8.8L96 160 48 160c-26.5 0-48 21.5-48 48l0 96c0 26.5 21.5 48 48 48zM441.1 107c-10.3-8.4-25.4-6.8-33.8 3.5s-6.8 25.4 3.5 33.8C443.3 170.7 464 210.9 464 256s-20.7 85.3-53.2 111.8c-10.3 8.4-11.8 23.5-3.5 33.8s23.5 11.8 33.8 3.5c43.2-35.2 70.9-88.9 70.9-149s-27.7-113.8-70.9-149zm-60.5 74.5c-10.3-8.4-25.4-6.8-33.8 3.5s-6.8 25.4 3.5 33.8C361.1 227.6 368 241 368 256s-6.9 28.4-17.7 37.3c-10.3 8.4-11.8 23.5-3.5 33.8s23.5 11.8 33.8 3.5C402.1 312.9 416 286.1 416 256s-13.9-56.9-35.5-74.5z"/></svg>`,"volume-low":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M48 352l48 0 134.1 119.2c6.4 5.7 14.6 8.8 23.1 8.8 19.2 0 34.8-15.6 34.8-34.8l0-378.4c0-19.2-15.6-34.8-34.8-34.8-8.5 0-16.7 3.1-23.1 8.8L96 160 48 160c-26.5 0-48 21.5-48 48l0 96c0 26.5 21.5 48 48 48zM380.6 181.5c-10.3-8.4-25.4-6.8-33.8 3.5s-6.8 25.4 3.5 33.8C361.1 227.6 368 241 368 256s-6.9 28.4-17.7 37.3c-10.3 8.4-11.8 23.5-3.5 33.8s23.5 11.8 33.8 3.5C402.1 312.9 416 286.1 416 256s-13.9-56.9-35.5-74.5z"/></svg>`,"volume-xmark":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path fill="currentColor" d="M48 352l48 0 134.1 119.2c6.4 5.7 14.6 8.8 23.1 8.8 19.2 0 34.8-15.6 34.8-34.8l0-378.4c0-19.2-15.6-34.8-34.8-34.8-8.5 0-16.7 3.1-23.1 8.8L96 160 48 160c-26.5 0-48 21.5-48 48l0 96c0 26.5 21.5 48 48 48zM367 175c-9.4 9.4-9.4 24.6 0 33.9l47 47-47 47c-9.4 9.4-9.4 24.6 0 33.9s24.6 9.4 33.9 0l47-47 47 47c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-47-47 47-47c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0l-47 47-47-47c-9.4-9.4-24.6-9.4-33.9 0z"/></svg>`,xmark:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 384 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M55.1 73.4c-12.5-12.5-32.8-12.5-45.3 0s-12.5 32.8 0 45.3L147.2 256 9.9 393.4c-12.5 12.5-12.5 32.8 0 45.3s32.8 12.5 45.3 0L192.5 301.3 329.9 438.6c12.5 12.5 32.8 12.5 45.3 0s12.5-32.8 0-45.3L237.8 256 375.1 118.6c12.5-12.5 12.5-32.8 0-45.3s-32.8-12.5-45.3 0L192.5 210.7 55.1 73.4z"/></svg>`},regular:{calendar:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M216 64C229.3 64 240 74.7 240 88L240 128L400 128L400 88C400 74.7 410.7 64 424 64C437.3 64 448 74.7 448 88L448 128L480 128C515.3 128 544 156.7 544 192L544 480C544 515.3 515.3 544 480 544L160 544C124.7 544 96 515.3 96 480L96 192C96 156.7 124.7 128 160 128L192 128L192 88C192 74.7 202.7 64 216 64zM216 176L160 176C151.2 176 144 183.2 144 192L144 240L496 240L496 192C496 183.2 488.8 176 480 176L216 176zM144 288L144 480C144 488.8 151.2 496 160 496L480 496C488.8 496 496 488.8 496 480L496 288L144 288z"/></svg>`,"circle-question":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M464 256a208 208 0 1 0 -416 0 208 208 0 1 0 416 0zM0 256a256 256 0 1 1 512 0 256 256 0 1 1 -512 0zm256-80c-17.7 0-32 14.3-32 32 0 13.3-10.7 24-24 24s-24-10.7-24-24c0-44.2 35.8-80 80-80s80 35.8 80 80c0 47.2-36 67.2-56 74.5l0 3.8c0 13.3-10.7 24-24 24s-24-10.7-24-24l0-8.1c0-20.5 14.8-35.2 30.1-40.2 6.4-2.1 13.2-5.5 18.2-10.3 4.3-4.2 7.7-10 7.7-19.6 0-17.7-14.3-32-32-32zM224 368a32 32 0 1 1 64 0 32 32 0 1 1 -64 0z"/></svg>`,"circle-xmark":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M256 48a208 208 0 1 1 0 416 208 208 0 1 1 0-416zm0 464a256 256 0 1 0 0-512 256 256 0 1 0 0 512zM167 167c-9.4 9.4-9.4 24.6 0 33.9l55 55-55 55c-9.4 9.4-9.4 24.6 0 33.9s24.6 9.4 33.9 0l55-55 55 55c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-55-55 55-55c9.4-9.4 9.4-24.6 0-33.9s-24.6-9.4-33.9 0l-55 55-55-55c-9.4-9.4-24.6-9.4-33.9 0z"/></svg>`,clock:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 640"><!--!Font Awesome Free v7.2.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2026 Fonticons, Inc.--><path d="M528 320C528 434.9 434.9 528 320 528C205.1 528 112 434.9 112 320C112 205.1 205.1 112 320 112C434.9 112 528 205.1 528 320zM64 320C64 461.4 178.6 576 320 576C461.4 576 576 461.4 576 320C576 178.6 461.4 64 320 64C178.6 64 64 178.6 64 320zM296 184L296 320C296 328 300 335.5 306.7 340L402.7 404C413.7 411.4 428.6 408.4 436 397.3C443.4 386.2 440.4 371.4 429.3 364L344 307.2L344 184C344 170.7 333.3 160 320 160C306.7 160 296 170.7 296 184z"/></svg>`,copy:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M384 336l-192 0c-8.8 0-16-7.2-16-16l0-256c0-8.8 7.2-16 16-16l133.5 0c4.2 0 8.3 1.7 11.3 4.7l58.5 58.5c3 3 4.7 7.1 4.7 11.3L400 320c0 8.8-7.2 16-16 16zM192 384l192 0c35.3 0 64-28.7 64-64l0-197.5c0-17-6.7-33.3-18.7-45.3L370.7 18.7C358.7 6.7 342.5 0 325.5 0L192 0c-35.3 0-64 28.7-64 64l0 256c0 35.3 28.7 64 64 64zM64 128c-35.3 0-64 28.7-64 64L0 448c0 35.3 28.7 64 64 64l192 0c35.3 0 64-28.7 64-64l0-16-48 0 0 16c0 8.8-7.2 16-16 16L64 464c-8.8 0-16-7.2-16-16l0-256c0-8.8 7.2-16 16-16l16 0 0-48-16 0z"/></svg>`,eye:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M288 80C222.8 80 169.2 109.6 128.1 147.7 89.6 183.5 63 226 49.4 256 63 286 89.6 328.5 128.1 364.3 169.2 402.4 222.8 432 288 432s118.8-29.6 159.9-67.7C486.4 328.5 513 286 526.6 256 513 226 486.4 183.5 447.9 147.7 406.8 109.6 353.2 80 288 80zM95.4 112.6C142.5 68.8 207.2 32 288 32s145.5 36.8 192.6 80.6c46.8 43.5 78.1 95.4 93 131.1 3.3 7.9 3.3 16.7 0 24.6-14.9 35.7-46.2 87.7-93 131.1-47.1 43.7-111.8 80.6-192.6 80.6S142.5 443.2 95.4 399.4c-46.8-43.5-78.1-95.4-93-131.1-3.3-7.9-3.3-16.7 0-24.6 14.9-35.7 46.2-87.7 93-131.1zM288 336c44.2 0 80-35.8 80-80 0-29.6-16.1-55.5-40-69.3-1.4 59.7-49.6 107.9-109.3 109.3 13.8 23.9 39.7 40 69.3 40zm-79.6-88.4c2.5 .3 5 .4 7.6 .4 35.3 0 64-28.7 64-64 0-2.6-.2-5.1-.4-7.6-37.4 3.9-67.2 33.7-71.1 71.1zm45.6-115c10.8-3 22.2-4.5 33.9-4.5 8.8 0 17.5 .9 25.8 2.6 .3 .1 .5 .1 .8 .2 57.9 12.2 101.4 63.7 101.4 125.2 0 70.7-57.3 128-128 128-61.6 0-113-43.5-125.2-101.4-1.8-8.6-2.8-17.5-2.8-26.6 0-11 1.4-21.8 4-32 .2-.7 .3-1.3 .5-1.9 11.9-43.4 46.1-77.6 89.5-89.5z"/></svg>`,"eye-slash":`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M41-24.9c-9.4-9.4-24.6-9.4-33.9 0S-2.3-.3 7 9.1l528 528c9.4 9.4 24.6 9.4 33.9 0s9.4-24.6 0-33.9l-96.4-96.4c2.7-2.4 5.4-4.8 8-7.2 46.8-43.5 78.1-95.4 93-131.1 3.3-7.9 3.3-16.7 0-24.6-14.9-35.7-46.2-87.7-93-131.1-47.1-43.7-111.8-80.6-192.6-80.6-56.8 0-105.6 18.2-146 44.2L41-24.9zM176.9 111.1c32.1-18.9 69.2-31.1 111.1-31.1 65.2 0 118.8 29.6 159.9 67.7 38.5 35.7 65.1 78.3 78.6 108.3-13.6 30-40.2 72.5-78.6 108.3-3.1 2.8-6.2 5.6-9.4 8.4L393.8 328c14-20.5 22.2-45.3 22.2-72 0-70.7-57.3-128-128-128-26.7 0-51.5 8.2-72 22.2l-39.1-39.1zm182 182l-108-108c11.1-5.8 23.7-9.1 37.1-9.1 44.2 0 80 35.8 80 80 0 13.4-3.3 26-9.1 37.1zM103.4 173.2l-34-34c-32.6 36.8-55 75.8-66.9 104.5-3.3 7.9-3.3 16.7 0 24.6 14.9 35.7 46.2 87.7 93 131.1 47.1 43.7 111.8 80.6 192.6 80.6 37.3 0 71.2-7.9 101.5-20.6L352.2 422c-20 6.4-41.4 10-64.2 10-65.2 0-118.8-29.6-159.9-67.7-38.5-35.7-65.1-78.3-78.6-108.3 10.4-23.1 28.6-53.6 54-82.8z"/></svg>`,star:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 576 512"><!--! Font Awesome Free 7.0.0 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2025 Fonticons, Inc. --><path fill="currentColor" d="M288.1-32c9 0 17.3 5.1 21.4 13.1L383 125.3 542.9 150.7c8.9 1.4 16.3 7.7 19.1 16.3s.5 18-5.8 24.4L441.7 305.9 467 465.8c1.4 8.9-2.3 17.9-9.6 23.2s-17 6.1-25 2L288.1 417.6 143.8 491c-8 4.1-17.7 3.3-25-2s-11-14.2-9.6-23.2L134.4 305.9 20 191.4c-6.4-6.4-8.6-15.8-5.8-24.4s10.1-14.9 19.1-16.3l159.9-25.4 73.6-144.2c4.1-8 12.4-13.1 21.4-13.1zm0 76.8L230.3 158c-3.5 6.8-10 11.6-17.6 12.8l-125.5 20 89.8 89.9c5.4 5.4 7.9 13.1 6.7 20.7l-19.8 125.5 113.3-57.6c6.8-3.5 14.9-3.5 21.8 0l113.3 57.6-19.8-125.5c-1.2-7.6 1.3-15.3 6.7-20.7l89.8-89.9-125.5-20c-7.6-1.2-14.1-6-17.6-12.8L288.1 44.8z"/></svg>`}},En={name:`system`,resolver:(e,t=`classic`,n=`solid`)=>{let r=Tn[n][e]??Tn.regular[e]??Tn.regular[`circle-question`];return r?wn(r):``}},Dn=`classic`,On=[Cn,En],kn=new Set;function An(e){kn.add(e)}function jn(e){kn.delete(e)}function Mn(e){return On.find(t=>t.name===e)}function Nn(e,t){Pn(e),On.push({name:e,resolver:t.resolver,mutator:t.mutator,spriteSheet:t.spriteSheet}),kn.forEach(t=>{t.library===e&&t.setIcon()})}function Pn(e){On=On.filter(t=>t.name!==e)}function Fn(){return Dn}var In=class extends Event{constructor(){super(`wa-error`,{bubbles:!0,cancelable:!1,composed:!0})}},Ln=class extends Event{constructor(){super(`wa-load`,{bubbles:!0,cancelable:!1,composed:!0})}},Rn=w`
  :host {
    --primary-color: currentColor;
    --primary-opacity: 1;
    --secondary-color: currentColor;
    --secondary-opacity: 0.4;
    --rotate-angle: 0deg;

    box-sizing: content-box;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    vertical-align: -0.125em;
  }

  /* #region Canvas — the box the icon is centered within (mirrors Font Awesome's icon canvas). Orthogonal to font-size. */

  /* Fixed width (default): 1.25em × 1em (20 × 16px) */
  :host(:not([canvas])),
  :host([canvas='fixed']) {
    width: 1.25em;
    height: 1em;
    min-width: 1.25em; /* <-- this is what Safari respects for intrinsic */
    min-height: 1em;
  }

  /* Auto: hug the icon's width. \`auto-width\` is the deprecated alias for canvas="auto". */
  :host([canvas='auto']),
  :host([auto-width]:not([canvas])) {
    width: auto;
    height: 1em;
  }

  /* Square: 1.25em × 1.25em (20 × 20px) */
  :host([canvas='square']) {
    width: 1.25em;
    height: 1.25em;
    min-width: 1.25em;
    min-height: 1.25em;
  }

  /* Roomy: 1.5em × 1.5em (24 × 24px) */
  :host([canvas='roomy']) {
    width: 1.5em;
    height: 1.5em;
    min-width: 1.5em;
    min-height: 1.5em;
  }

  /* #endregion */

  svg {
    /* NOTE: Avoid setting fill here. A stylesheet rule beats SVG presentation attributes, breaking stroke-based
       libraries like Lucide (fill="none" stroke="currentColor") and attribute-based mutators (issue #1733). The default
       library applies fill="currentColor" in its mutator instead. */
    height: 1em;
    overflow: visible;
    width: auto;

    /* Duotone colors with path-specific opacity fallback */
    path[data-duotone-primary] {
      color: var(--primary-color);
      opacity: var(--path-opacity, var(--primary-opacity));
    }

    path[data-duotone-secondary] {
      color: var(--secondary-color);
      opacity: var(--path-opacity, var(--secondary-opacity));
    }
  }

  /* Rotation */
  :host([rotate]) {
    transform: rotate(var(--rotate-angle, 0deg));
  }

  /* Flipping */
  :host([flip='x']) {
    transform: scaleX(-1);
  }
  :host([flip='y']) {
    transform: scaleY(-1);
  }
  :host([flip='both']) {
    transform: scale(-1, -1);
  }

  /* Rotation and Flipping combined */
  :host([rotate][flip='x']) {
    transform: rotate(var(--rotate-angle, 0deg)) scaleX(-1);
  }
  :host([rotate][flip='y']) {
    transform: rotate(var(--rotate-angle, 0deg)) scaleY(-1);
  }
  :host([rotate][flip='both']) {
    transform: rotate(var(--rotate-angle, 0deg)) scale(-1, -1);
  }

  /* #region Animations — ported from Font Awesome 7.3 (--fa-* props mapped to wa-icon's --* names) */

  :host([animation='beat']) {
    animation-name: beat;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 1s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-in-out);
  }

  :host([animation='bounce']) {
    animation-name: bounce;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 1s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, cubic-bezier(0.28, 0.84, 0.42, 1));
  }

  :host([animation='fade']) {
    animation-name: fade;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 1s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-in-out);
  }

  :host([animation='beat-fade']) {
    animation-name: beat-fade;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 1s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-in-out);
  }

  :host([animation='flip']) {
    animation-name: flip;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 1.5s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-in-out);
  }

  :host([animation='flip-360']) {
    animation-name: flip-360;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 1s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-in-out);
  }

  :host([animation='shake']) {
    animation-name: shake;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 0.75s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-in-out);
  }

  :host([animation='spin']) {
    animation-name: spin;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 2s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, linear);
  }

  :host([animation='spin-pulse']) {
    animation-name: spin;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 1s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, steps(8));
  }

  /* spin-reverse is FA's reverse modifier expressed as a standalone value; reverse any spin via --animation-direction: reverse */
  :host([animation='spin-reverse']) {
    animation-name: spin;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, reverse);
    animation-duration: var(--animation-duration, 2s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, linear);
  }

  :host([animation='spin-snap']) {
    animation-name: spin-snap;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 3s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, linear);
  }

  :host([animation='spin-snap-4']) {
    animation-name: spin-snap-4;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 2.4s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, linear);
  }

  :host([animation='spin-snap-8']) {
    animation-name: spin-snap-8;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 4s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, linear);
  }

  :host([animation='buzz']) {
    animation-name: buzz;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 0.6s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, linear);
  }

  :host([animation='wag']) {
    animation-name: wag;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 0.9s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-out);
    transform-origin: bottom center;
  }

  :host([animation='float']) {
    animation-name: float;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 3s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-in-out);
    will-change: transform;
  }

  :host([animation='swing']) {
    animation-name: swing;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 1.2s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-out);
    transform-origin: top center;
  }

  :host([animation='jello']) {
    animation-name: jello;
    animation-delay: var(--animation-delay, 0s);
    animation-direction: var(--animation-direction, normal);
    animation-duration: var(--animation-duration, 0.9s);
    animation-iteration-count: var(--animation-iteration-count, infinite);
    animation-timing-function: var(--animation-timing, ease-out);
  }

  @media (prefers-reduced-motion: reduce) {
    :host([animation='beat']),
    :host([animation='bounce']),
    :host([animation='fade']),
    :host([animation='beat-fade']),
    :host([animation='flip']),
    :host([animation='flip-360']),
    :host([animation='shake']),
    :host([animation='spin']),
    :host([animation='spin-pulse']),
    :host([animation='spin-reverse']),
    :host([animation='spin-snap']),
    :host([animation='spin-snap-4']),
    :host([animation='spin-snap-8']),
    :host([animation='buzz']),
    :host([animation='wag']),
    :host([animation='float']),
    :host([animation='swing']),
    :host([animation='jello']) {
      animation: none !important;
      transition: none !important;
    }
  }

  /* #endregion */

  /* #region Keyframes — ported verbatim from Font Awesome 7.3 */

  @keyframes beat {
    0% {
      transform: scale(1);
    }
    25% {
      transform: scale(calc(1.25 * var(--beat-scale, 1.25)));
    }
    45% {
      transform: scale(calc(1.22 * var(--beat-scale, 1.22)));
    }
    65% {
      transform: scale(calc(1.25 * var(--beat-scale, 1.25)));
    }
    90% {
      transform: scale(1);
    }
  }

  @keyframes bounce {
    0% {
      transform: scale(1, 1) translateY(0);
      /* No fallback by design (ported from FA 7.3): the first segment uses the user's --animation-timing or the CSS
         initial ease, while the explicit cubic-beziers on later stops drive the bounce physics. */
      animation-timing-function: var(--animation-timing);
    }
    14% {
      transform: scale(var(--bounce-start-scale-x, 1.06), var(--bounce-start-scale-y, 0.94))
        translateY(var(--bounce-anticipation, 3px));
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 0.33);
    }
    32% {
      transform: scale(var(--bounce-jump-scale-x, 0.94), var(--bounce-jump-scale-y, 1.12))
        translateY(calc(-1 * var(--bounce-height, 0.5em)));
      animation-timing-function: cubic-bezier(0.33, 0.66, 0.66, 1);
    }
    52% {
      transform: scale(1, 1) translateY(calc(-1 * var(--bounce-height, 0.5em) * 1.1));
      animation-timing-function: cubic-bezier(0.5, 0, 1, 0.5);
    }
    70% {
      transform: scale(var(--bounce-land-scale-x, 1.06), var(--bounce-land-scale-y, 0.92)) translateY(0);
      animation-timing-function: cubic-bezier(0.33, 0.33, 0.66, 1);
    }
    85% {
      transform: scale(0.98, 1.04) translateY(calc(-2px * var(--bounce-rebound, 1)));
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 1);
    }
    100% {
      transform: scale(1, 1) translateY(0);
    }
  }

  @keyframes fade {
    0% {
      opacity: 1;
      transform: scale(1);
      animation-timing-function: cubic-bezier(0.2, 0, 0.4, 1);
    }
    40% {
      opacity: var(--fade-opacity, 0.4);
      transform: scale(0.98);
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    100% {
      opacity: 1;
      transform: scale(1);
    }
  }

  @keyframes beat-fade {
    0% {
      opacity: var(--beat-fade-opacity, 0.4);
      transform: scale(1);
      animation-timing-function: cubic-bezier(0.2, 0, 0.4, 1);
    }
    25% {
      opacity: calc(var(--beat-fade-opacity, 0.4) + 0.4);
      transform: scale(var(--beat-fade-scale, 1.28));
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    45% {
      opacity: 1;
      transform: scale(var(--beat-fade-scale, 1.25));
      animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
    65% {
      opacity: calc(var(--beat-fade-opacity, 0.4) + 0.4);
      transform: scale(var(--beat-fade-scale, 1.28));
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    100% {
      opacity: var(--beat-fade-opacity, 0.4);
      transform: scale(1);
    }
  }

  @keyframes flip {
    0% {
      transform: perspective(2em) scale(1) rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), 0deg);
      animation-timing-function: cubic-bezier(0.2, 0, 0.4, 1);
    }
    8% {
      transform: perspective(2em) scale(var(--flip-anticipation-scale, 0.95))
        rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), 0deg);
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 0.33);
    }
    35% {
      transform: perspective(2em) scale(1)
        rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), calc(var(--flip-angle, -360deg) * 0.6));
      animation-timing-function: linear;
    }
    65% {
      transform: perspective(2em) scale(1)
        rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), calc(var(--flip-angle, -360deg) * 0.5));
      animation-timing-function: cubic-bezier(0.33, 0.66, 0.66, 1);
    }
    92% {
      transform: perspective(2em) scale(1)
        rotate3d(
          var(--flip-x, 0),
          var(--flip-y, 1),
          var(--flip-z, 0),
          calc(var(--flip-angle, -360deg) * var(--flip-overshoot, 1.04))
        );
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 1);
    }
    100% {
      transform: perspective(2em) scale(1)
        rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), var(--flip-angle, -360deg));
    }
  }

  @keyframes flip-360 {
    0% {
      transform: perspective(2em) scale(1) rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), 0deg);
      animation-timing-function: cubic-bezier(0.2, 0, 0.4, 1);
    }
    8% {
      transform: perspective(2em) scale(var(--flip-anticipation-scale, 0.95))
        rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), 0deg);
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 0.33);
    }
    50% {
      transform: perspective(2em) scale(1)
        rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), calc(var(--flip-angle, -360deg) * 0.6));
      animation-timing-function: cubic-bezier(0.33, 0.66, 0.66, 1);
    }
    80% {
      transform: perspective(2em) scale(1)
        rotate3d(
          var(--flip-x, 0),
          var(--flip-y, 1),
          var(--flip-z, 0),
          calc(var(--flip-angle, -360deg) * var(--flip-overshoot, 1.04))
        );
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 1);
    }
    100% {
      transform: perspective(2em) scale(1)
        rotate3d(var(--flip-x, 0), var(--flip-y, 1), var(--flip-z, 0), var(--flip-angle, -360deg));
    }
  }

  @keyframes shake {
    0% {
      transform: rotate(0deg);
      animation-timing-function: cubic-bezier(0.2, 0, 0.8, 1);
    }
    8% {
      transform: rotate(35deg) translateX(1px);
      animation-timing-function: cubic-bezier(0.3, 0, 0.7, 1);
    }
    20% {
      transform: rotate(-22deg) translateX(-1px);
      animation-timing-function: cubic-bezier(0.3, 0, 0.7, 1);
    }
    35% {
      transform: rotate(15deg) translateX(1px);
      animation-timing-function: cubic-bezier(0.3, 0, 0.7, 1);
    }
    50% {
      transform: rotate(-9deg);
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    65% {
      transform: rotate(5deg);
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    78% {
      transform: rotate(-3deg);
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    90% {
      transform: rotate(1deg);
      animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
    100% {
      transform: rotate(0deg);
    }
  }

  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  @keyframes spin-snap {
    0% {
      transform: rotate(0deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    12% {
      transform: rotate(60deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    16.67% {
      transform: rotate(60deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    28.67% {
      transform: rotate(120deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    33.33% {
      transform: rotate(120deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    45.33% {
      transform: rotate(180deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    50% {
      transform: rotate(180deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    62% {
      transform: rotate(240deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    66.67% {
      transform: rotate(240deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    78.67% {
      transform: rotate(300deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    83.33% {
      transform: rotate(300deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    95.33% {
      transform: rotate(360deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  @keyframes spin-snap-4 {
    0% {
      transform: rotate(0deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    15% {
      transform: rotate(90deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    25% {
      transform: rotate(90deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    40% {
      transform: rotate(180deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    50% {
      transform: rotate(180deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    65% {
      transform: rotate(270deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    75% {
      transform: rotate(270deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    90% {
      transform: rotate(360deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  @keyframes spin-snap-8 {
    0% {
      transform: rotate(0deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    9% {
      transform: rotate(45deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    12.5% {
      transform: rotate(45deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    21.5% {
      transform: rotate(90deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    25% {
      transform: rotate(90deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    34% {
      transform: rotate(135deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    37.5% {
      transform: rotate(135deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    46.5% {
      transform: rotate(180deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    50% {
      transform: rotate(180deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    59% {
      transform: rotate(225deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    62.5% {
      transform: rotate(225deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    71.5% {
      transform: rotate(270deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    75% {
      transform: rotate(270deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    84% {
      transform: rotate(315deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    87.5% {
      transform: rotate(315deg);
      animation-timing-function: cubic-bezier(0, 0, 0.2, 1);
    }
    96.5% {
      transform: rotate(360deg);
      animation-timing-function: cubic-bezier(0.8, 0, 1, 1);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  @keyframes buzz {
    0% {
      transform: translateX(0) rotate(0deg);
      animation-timing-function: cubic-bezier(0.1, 0, 0.9, 1);
    }
    5% {
      transform: translateX(var(--buzz-distance, 4px)) rotate(0.5deg);
    }
    10% {
      transform: translateX(calc(-1 * var(--buzz-distance, 4px))) rotate(-0.5deg);
    }
    15% {
      transform: translateX(var(--buzz-distance, 4px)) rotate(0.3deg);
    }
    20% {
      transform: translateX(calc(-1 * var(--buzz-distance, 4px))) rotate(-0.3deg);
    }
    25% {
      transform: translateX(calc(var(--buzz-distance, 4px) * 0.7)) rotate(0.2deg);
    }
    30% {
      transform: translateX(calc(-1 * var(--buzz-distance, 4px) * 0.7)) rotate(-0.2deg);
    }
    35% {
      transform: translateX(calc(var(--buzz-distance, 4px) * 0.4)) rotate(0.1deg);
    }
    40% {
      transform: translateX(0) rotate(0deg);
    }
    100% {
      transform: translateX(0) rotate(0deg);
    }
  }

  @keyframes wag {
    0% {
      transform: rotate(0deg);
      animation-timing-function: cubic-bezier(0.2, 0, 0.6, 1);
    }
    12% {
      transform: rotate(var(--wag-angle, 12deg));
      animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
    24% {
      transform: rotate(2deg);
      animation-timing-function: cubic-bezier(0.2, 0, 0.6, 1);
    }
    36% {
      transform: rotate(calc(var(--wag-angle, 12deg) * 0.85));
      animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
    48% {
      transform: rotate(1deg);
      animation-timing-function: cubic-bezier(0.2, 0, 0.6, 1);
    }
    58% {
      transform: rotate(calc(var(--wag-angle, 12deg) * 0.6));
      animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
    68% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(0deg);
    }
  }

  @keyframes float {
    0% {
      transform: translateY(0) translateX(0) rotate(0deg)
        scale(var(--float-squash-x, 1.02), var(--float-squash-y, 0.98));
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 0.33);
    }
    15% {
      transform: translateY(calc(-0.4 * var(--float-height, 6px))) translateX(var(--float-drift, 1px))
        rotate(var(--float-tilt, 1deg)) scale(1, 1);
      animation-timing-function: cubic-bezier(0.33, 0.66, 0.66, 1);
    }
    35% {
      transform: translateY(calc(-1 * var(--float-height, 6px))) translateX(0) rotate(0deg)
        scale(var(--float-stretch-x, 0.98), var(--float-stretch-y, 1.03));
      animation-timing-function: cubic-bezier(0.5, 0, 0.5, 0);
    }
    50% {
      transform: translateY(calc(-0.92 * var(--float-height, 6px))) translateX(calc(-0.5 * var(--float-drift, 1px)))
        rotate(calc(-0.5 * var(--float-tilt, 1deg))) scale(0.995, 1.01);
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 0.33);
    }
    70% {
      transform: translateY(calc(-0.3 * var(--float-height, 6px))) translateX(calc(-1 * var(--float-drift, 1px)))
        rotate(calc(-1 * var(--float-tilt, 1deg))) scale(1, 1);
      animation-timing-function: cubic-bezier(0.33, 0.66, 0.66, 1);
    }
    90% {
      transform: translateY(calc(0.05 * var(--float-height, 6px))) translateX(0) rotate(0deg)
        scale(var(--float-squash-x, 1.02), var(--float-squash-y, 0.98));
      animation-timing-function: cubic-bezier(0.33, 0, 0.66, 1);
    }
    100% {
      transform: translateY(0) translateX(0) rotate(0deg)
        scale(var(--float-squash-x, 1.02), var(--float-squash-y, 0.98));
    }
  }

  @keyframes swing {
    0% {
      transform: rotate(0deg);
      animation-timing-function: cubic-bezier(0.2, 0, 0.8, 1);
    }
    8% {
      transform: rotate(var(--swing-angle, 22deg));
      animation-timing-function: cubic-bezier(0.3, 0, 0.7, 1);
    }
    18% {
      transform: rotate(calc(-1 * var(--swing-angle, 22deg) * 0.85));
      animation-timing-function: cubic-bezier(0.3, 0, 0.7, 1);
    }
    28% {
      transform: rotate(calc(var(--swing-angle, 22deg) * 0.65));
      animation-timing-function: cubic-bezier(0.35, 0, 0.65, 1);
    }
    38% {
      transform: rotate(calc(-1 * var(--swing-angle, 22deg) * 0.45));
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    48% {
      transform: rotate(calc(var(--swing-angle, 22deg) * 0.25));
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    56% {
      transform: rotate(calc(-1 * var(--swing-angle, 22deg) * 0.1));
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    64% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(0deg);
    }
  }

  @keyframes jello {
    0% {
      transform: scale(1, 1);
      animation-timing-function: cubic-bezier(0.2, 0, 0.8, 1);
    }
    12% {
      transform: scale(var(--jello-scale-x, 1.15), calc(2 - var(--jello-scale-x, 1.15)));
      animation-timing-function: cubic-bezier(0.3, 0, 0.7, 1);
    }
    24% {
      transform: scale(calc(2 - var(--jello-scale-y, 1.12)), var(--jello-scale-y, 1.12));
      animation-timing-function: cubic-bezier(0.3, 0, 0.7, 1);
    }
    36% {
      transform: scale(
        calc(1 + (var(--jello-scale-x, 1.15) - 1) * 0.5),
        calc(2 - (1 + (var(--jello-scale-x, 1.15) - 1) * 0.5))
      );
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    48% {
      transform: scale(
        calc(2 - (1 + (var(--jello-scale-y, 1.12) - 1) * 0.3)),
        calc(1 + (var(--jello-scale-y, 1.12) - 1) * 0.3)
      );
      animation-timing-function: cubic-bezier(0.4, 0, 0.6, 1);
    }
    58% {
      transform: scale(1.02, 0.98);
      animation-timing-function: cubic-bezier(0.4, 0, 0.2, 1);
    }
    68% {
      transform: scale(1, 1);
    }
    100% {
      transform: scale(1, 1);
    }
  }

  /* #endregion */
`;function B(e,t){let n={waitUntilFirstUpdate:!1,...t};return(t,r)=>{let{update:i}=t,a=Array.isArray(e)?e:[e];t.update=function(e){a.forEach(t=>{let i=t;if(e.has(i)){let t=e.get(i),a=this[i];t!==a&&(!n.waitUntilFirstUpdate||this.hasUpdated)&&this[r](t,a)}}),i.call(this,e)}}}var{_ChildPart:zn}=Et;window.ShadyDOM?.inUse&&window.ShadyDOM?.noPatch===!0&&window.ShadyDOM.wrap;var Bn=(e,t)=>t===void 0?e?._$litType$!==void 0:e?._$litType$===t,Vn=e=>e.strings===void 0,Hn={},Un=(e,t=Hn)=>e._$committedValue=t,Wn=Symbol(),Gn=Symbol(),Kn,qn=new Map,V=class extends z{constructor(){super(...arguments),this.svg=null,this.autoWidth=!1,this.swapOpacity=!1,this.label=``,this.library=`default`,this.rotate=0,this.resolveIcon=async(e,t)=>{let n;if(t?.spriteSheet){this.hasUpdated||await this.updateComplete,this.svg=j`<svg part="svg">
        <use part="use" href="${e}"></use>
      </svg>`,await this.updateComplete;let n=this.shadowRoot.querySelector(`[part='svg']`);return typeof t.mutator==`function`&&t.mutator(n,this),this.svg}try{if(n=await fetch(e,{mode:`cors`}),!n.ok)return n.status===410?Wn:Gn}catch{return Gn}try{let e=document.createElement(`div`);e.innerHTML=await n.text();let t=e.firstElementChild;if(t?.tagName?.toLowerCase()!==`svg`)return Wn;Kn||=new DOMParser;let r=Kn.parseFromString(t.outerHTML,`text/html`).body.querySelector(`svg`);return r?(r.part.add(`svg`),document.adoptNode(r)):Wn}catch{return Wn}}}connectedCallback(){super.connectedCallback(),An(this)}firstUpdated(e){super.firstUpdated(e),this.hasAttribute(`rotate`)&&this.style.setProperty(`--rotate-angle`,`${this.rotate}deg`),this.setIcon()}disconnectedCallback(){super.disconnectedCallback(),jn(this)}async getIconSource(){let e=Mn(this.library),t=this.family||Fn();if(this.name&&e){let n=this.canvas===`auto`||this.autoWidth,r;try{r=await e.resolver(this.name,t,this.variant,n)}catch{r=void 0}return{url:r,fromLibrary:!0}}return{url:this.src,fromLibrary:!1}}handleLabelChange(){typeof this.label==`string`&&this.label.length>0?(this.setAttribute(`role`,`img`),this.setAttribute(`aria-label`,this.label),this.removeAttribute(`aria-hidden`)):(this.removeAttribute(`role`),this.removeAttribute(`aria-label`),this.setAttribute(`aria-hidden`,`true`))}async setIcon(){let{url:e,fromLibrary:t}=await this.getIconSource(),n=t?Mn(this.library):void 0;if(!e){this.svg=null;return}let r=qn.get(e);r||(r=this.resolveIcon(e,n),qn.set(e,r));let i=await r;if(i===Gn&&qn.delete(e),e===(await this.getIconSource()).url){if(Bn(i)){this.svg=i;return}switch(i){case Gn:case Wn:this.svg=null,this.dispatchEvent(new In);break;default:this.svg=i.cloneNode(!0),n?.mutator?.(this.svg,this),this.dispatchEvent(new Ln)}}}willUpdate(e){return this.style||this.setStyleProperty(`--rotate-angle`,`${this.rotate}deg`),super.willUpdate(e)}updated(e){super.updated(e);let t=Mn(this.library);this.hasAttribute(`rotate`)&&this.style.setProperty(`--rotate-angle`,`${this.rotate}deg`);let n=this.shadowRoot?.querySelector(`svg`);n&&t?.mutator?.(n,this)}render(){return this.hasUpdated?this.svg:j`<svg part="svg" width="16" height="16" viewBox="0 0 16 16"></svg>`}};V.css=Rn,P([L()],V.prototype,`svg`,2),P([I({reflect:!0})],V.prototype,`name`,2),P([I({reflect:!0})],V.prototype,`family`,2),P([I({reflect:!0})],V.prototype,`variant`,2),P([I({reflect:!0})],V.prototype,`canvas`,2),P([I({attribute:`auto-width`,type:Boolean,reflect:!0})],V.prototype,`autoWidth`,2),P([I({attribute:`swap-opacity`,type:Boolean,reflect:!0})],V.prototype,`swapOpacity`,2),P([I()],V.prototype,`src`,2),P([I()],V.prototype,`label`,2),P([I({reflect:!0})],V.prototype,`library`,2),P([I({type:Number,reflect:!0})],V.prototype,`rotate`,2),P([I({type:String,reflect:!0})],V.prototype,`flip`,2),P([I({type:String,reflect:!0})],V.prototype,`animation`,2),P([B(`label`)],V.prototype,`handleLabelChange`,1),P([B([`family`,`name`,`library`,`variant`,`src`,`autoWidth`,`canvas`,`swapOpacity`],{waitUntilFirstUpdate:!0})],V.prototype,`setIcon`,1),V=P([F(`wa-icon`)],V);var Jn=class extends Event{constructor(){super(`wa-clear`,{bubbles:!0,cancelable:!1,composed:!0})}};function Yn(e,t){let n=e.metaKey||e.ctrlKey||e.shiftKey||e.altKey;e.key===`Enter`&&!n&&setTimeout(()=>{!e.defaultPrevented&&!e.isComposing&&Xn(t)})}function Xn(e){let t=null;if(`form`in e&&(t=e.form),!t&&`getForm`in e&&(t=e.getForm()),!t)return;let n=[...t.elements];if(n.length===1){t.requestSubmit(null);return}let r=n.find(e=>e.type===`submit`&&!e.matches(`:disabled`));r&&([`input`,`button`].includes(r.localName)?t.requestSubmit(r):r.click())}var Zn=w`
  :host {
    border-width: 0;
  }

  :host(:focus) {
    outline: none;
  }

  .text-field {
    display: flex;
    align-items: stretch;
    justify-content: start;
    position: relative;
    transition: inherit;
    height: var(--wa-form-control-height);
    border-color: var(--wa-form-control-border-color);
    border-radius: var(--wa-form-control-border-radius);
    border-style: var(--wa-form-control-border-style);
    border-width: var(--wa-form-control-border-width);
    cursor: text;
    color: var(--wa-form-control-value-color);
    font-size: var(--wa-form-control-value-font-size);
    font-family: inherit;
    font-weight: var(--wa-form-control-value-font-weight);
    line-height: var(--wa-form-control-value-line-height);
    vertical-align: middle;
    width: 100%;
    transition:
      background-color var(--wa-transition-normal),
      border-color var(--wa-transition-normal),
      outline-color var(--wa-transition-fast);
    transition-timing-function: var(--wa-transition-easing);
    background-color: var(--wa-form-control-background-color);
    box-shadow: var(--box-shadow);
    padding: 0 var(--wa-form-control-padding-inline);
    outline: var(--wa-focus-ring-style) var(--wa-focus-ring-width) transparent;
    outline-offset: var(--wa-focus-ring-offset);

    &:focus-within {
      outline-color: var(--wa-color-focus);
    }

    /* Style disabled inputs */
    &:has(:disabled) {
      cursor: not-allowed;
      opacity: 0.5;
    }
  }

  /* Appearance modifiers */
  :host([appearance='outlined']) .text-field {
    background-color: var(--wa-form-control-background-color);
    border-color: var(--wa-form-control-border-color);
  }

  :host([appearance='filled']) .text-field {
    background-color: var(--wa-color-neutral-fill-quiet);
    border-color: var(--wa-color-neutral-fill-quiet);
  }

  :host([appearance='filled-outlined']) .text-field {
    background-color: var(--wa-color-neutral-fill-quiet);
    border-color: var(--wa-form-control-border-color);
  }

  :host([pill]) .text-field {
    border-radius: var(--wa-border-radius-pill) !important;
  }

  .text-field {
    /* Show autofill styles over the entire text field, not just the native <input> */
    &:has(:autofill),
    &:has(:-webkit-autofill) {
      background-color: var(--wa-color-brand-fill-quiet) !important;
    }

    input,
    textarea {
      /*
      Fixes an alignment issue with placeholders.
      https://github.com/shoelace-style/webawesome/issues/342
    */
      height: 100%;

      padding: 0;
      border: none;
      outline: none;
      box-shadow: none;
      margin: 0;
      cursor: inherit;
      -webkit-appearance: none;
      font: inherit;

      /* Turn off Safari's autofill styles */
      &:-webkit-autofill,
      &:-webkit-autofill:hover,
      &:-webkit-autofill:focus,
      &:-webkit-autofill:active {
        -webkit-background-clip: text;
        background-color: transparent;
        -webkit-text-fill-color: inherit;
      }
    }
  }

  input {
    flex: 1 1 auto;
    min-width: 0;
    height: 100%;
    transition: inherit;

    /* prettier-ignore */
    background-color: rgb(118 118 118 / 0); /* ensures proper placeholder styles in webkit's date input */
    height: calc(var(--wa-form-control-height) - var(--border-width) * 2);
    padding-block: 0;
    color: inherit;

    &:autofill {
      &,
      &:hover,
      &:focus,
      &:active {
        box-shadow: none;
        caret-color: var(--wa-form-control-value-color);
      }
    }

    &::placeholder {
      color: var(--wa-form-control-placeholder-color);
      user-select: none;
      -webkit-user-select: none;
    }

    &::-webkit-search-decoration,
    &::-webkit-search-cancel-button,
    &::-webkit-search-results-button,
    &::-webkit-search-results-decoration {
      -webkit-appearance: none;
    }

    &:focus {
      outline: none;
    }
  }

  textarea {
    &:autofill {
      &,
      &:hover,
      &:focus,
      &:active {
        box-shadow: none;
        caret-color: var(--wa-form-control-value-color);
      }
    }

    &::placeholder {
      color: var(--wa-form-control-placeholder-color);
      user-select: none;
      -webkit-user-select: none;
    }
  }

  .start,
  .end {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    cursor: default;

    &::slotted(wa-icon) {
      color: var(--wa-color-neutral-on-quiet);
    }
  }

  .start::slotted(*) {
    margin-inline-end: var(--wa-form-control-padding-inline);
  }

  .end::slotted(*) {
    margin-inline-start: var(--wa-form-control-padding-inline);
  }

  /*
   * Clearable + Password Toggle
   */

  .clear,
  .password-toggle {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: inherit;
    color: var(--wa-color-neutral-on-quiet);
    border: none;
    background: none;
    padding: 0;
    transition: var(--wa-transition-normal) color;
    cursor: pointer;
    margin-inline-start: var(--wa-form-control-padding-inline);

    @media (hover: hover) {
      &:hover {
        color: color-mix(in oklab, currentColor, var(--wa-color-mix-hover));
      }
    }

    &:active {
      color: color-mix(in oklab, currentColor, var(--wa-color-mix-active));
    }

    &:focus {
      outline: none;
    }
  }

  /* Don't show the browser's password toggle in Edge */
  ::-ms-reveal {
    display: none;
  }

  /* Hide the built-in number spinner */
  :host([without-spin-buttons]) input[type='number'] {
    -moz-appearance: textfield;

    &::-webkit-outer-spin-button,
    &::-webkit-inner-spin-button {
      -webkit-appearance: none;
      display: none;
    }
  }
`,Qn=w`
  :host {
    display: flex;
    flex-direction: column;
  }

  /* Treat wrapped labels, inputs, and hints as direct children of the host element */
  [part~='form-control'] {
    display: contents;
  }

  /* Label */
  :is([part~='form-control-label'], [part~='label']):has(*:not(:empty)),
  :is([part~='form-control-label'], [part~='label']).has-label {
    display: inline-flex;
    color: var(--wa-form-control-label-color);
    font-weight: var(--wa-form-control-label-font-weight);
    line-height: var(--wa-form-control-label-line-height);
    margin-block-end: 0.5em;
  }

  :host([required]) :is([part~='form-control-label'], [part~='label'])::after {
    content: var(--wa-form-control-required-content);
    margin-inline-start: var(--wa-form-control-required-content-offset);
    color: var(--wa-form-control-required-content-color);
  }

  /* Help text */
  [part~='hint'] {
    display: block;
    color: var(--wa-form-control-hint-color);
    font-weight: var(--wa-form-control-hint-font-weight);
    line-height: var(--wa-form-control-hint-line-height);
    margin-block-start: 0.5em;
    font-size: var(--wa-font-size-smaller);

    &:not(.has-slotted, .has-hint) {
      display: none;
    }
  }
`,$n=()=>({checkValidity(e){let t=e.input,n={message:``,isValid:!0,invalidKeys:[]};if(!t)return n;let r=!0;if(`checkValidity`in t&&(r=t.checkValidity()),r)return n;if(n.isValid=!1,`validationMessage`in t&&(n.message=t.validationMessage),!(`validity`in t))return n.invalidKeys.push(`customError`),n;for(let e in t.validity){if(e===`valid`)continue;let r=e;t.validity[r]&&n.invalidKeys.push(r)}return n}}),er=class extends Event{constructor(){super(`wa-invalid`,{bubbles:!0,cancelable:!1,composed:!0})}},tr=()=>({observedAttributes:[`custom-error`],checkValidity(e){let t={message:``,isValid:!0,invalidKeys:[]};return e.customError&&(t.message=e.customError,t.isValid=!1,t.invalidKeys=[`customError`]),t}}),H=class extends z{constructor(){super(),this.name=null,this.disabled=!1,this.required=!1,this.assumeInteractionOn=[`input`],this.validators=[],this.valueHasChanged=!1,this.hasInteracted=!1,this.customError=null,this.emittedEvents=[],this.emitInvalid=e=>{e.target===this&&(this.hasInteracted=!0,this.dispatchEvent(new er))},this.handleInteraction=e=>{let t=this.emittedEvents;t.includes(e.type)||t.push(e.type),t.length===this.assumeInteractionOn?.length&&(this.hasInteracted=!0)},`addEventListener`in this&&this.addEventListener(`invalid`,this.emitInvalid)}static get validators(){return[tr()]}static get observedAttributes(){let e=new Set(super.observedAttributes||[]);for(let t of this.validators)if(t.observedAttributes)for(let n of t.observedAttributes)e.add(n);return[...e]}connectedCallback(){super.connectedCallback(),this.didSSR&&!this.hasUpdated?this.updateComplete.then(()=>{this.updateValidity()}):this.updateValidity(),this.assumeInteractionOn.forEach(e=>{this.addEventListener?.(e,this.handleInteraction)})}firstUpdated(...e){super.firstUpdated(...e),this.updateValidity()}willUpdate(e){if(e.has(`customError`)&&(this.customError||=null,this.setCustomValidity(this.customError||``)),e.has(`value`)||e.has(`disabled`)||e.has(`defaultValue`)){let e=this.value;this.updateFormValue(e)}e.has(`disabled`)&&(this.customStates.set(`disabled`,this.disabled),(this.hasAttribute(`disabled`)||!this.matches(`:disabled`))&&this.toggleAttribute(`disabled`,this.disabled)),super.willUpdate(e),this.didSSR&&!this.hasUpdated?this.updateComplete.then(()=>this.updateValidity()):this.updateValidity()}updateFormValue(e){if(Array.isArray(e)){if(this.name){let t=new FormData;for(let n of e)t.append(this.name,n);this.setValue(t,t)}}else this.setValue(e,e)}get labels(){return this.internals.labels}getForm(){return this.internals.form}set form(e){e?this.setAttribute(`form`,e):this.removeAttribute(`form`)}get form(){return this.internals.form}get validity(){return this.internals.validity}get willValidate(){return this.internals.willValidate}get validationMessage(){return this.internals.validationMessage}checkValidity(){return this.updateValidity(),this.internals.checkValidity()}reportValidity(){return this.updateValidity(),this.hasInteracted=!0,this.internals.reportValidity()}get validationTarget(){return this.input||void 0}setValidity(...e){let t=e[0],n=e[1],r=e[2];r||=this.validationTarget,this.internals.setValidity(t,n,r||void 0),this.requestUpdate(`validity`),this.setCustomStates()}setCustomStates(){let e=!!this.required,t=this.internals.validity.valid,n=this.hasInteracted;this.customStates.set(`required`,e),this.customStates.set(`optional`,!e),this.customStates.set(`invalid`,!t),this.customStates.set(`valid`,t),this.customStates.set(`user-invalid`,!t&&n),this.customStates.set(`user-valid`,t&&n)}setCustomValidity(e){if(!e){this.customError=null,this.setValidity({});return}this.customError=e,this.setValidity({customError:!0},e,this.validationTarget)}formResetCallback(){this.resetValidity(),this.hasInteracted=!1,this.valueHasChanged=!1,this.emittedEvents=[],this.updateValidity()}formDisabledCallback(e){this.disabled=e,this.updateValidity()}formStateRestoreCallback(e,t){this.didSSR&&!this.hasUpdated?this.updateComplete.then(()=>{this.value=e,t===`restore`&&this.resetValidity(),this.updateValidity()}):(this.value=e,t===`restore`&&this.resetValidity(),this.updateValidity())}setValue(...e){let[t,n]=e;this.internals.setFormValue(t,n)}get allValidators(){let e=this.constructor.validators||[],t=this.validators||[];return[...e,...t]}resetValidity(){this.setCustomValidity(``),this.setValidity({})}updateValidity(){if(this.disabled||this.hasAttribute(`disabled`)||!this.willValidate){this.resetValidity();return}let e=this.allValidators;if(!e?.length)return;let t={customError:!!this.customError},n=this.validationTarget||this.input||void 0,r=``;for(let n of e){let{isValid:e,message:i,invalidKeys:a}=n.checkValidity(this);e||(r||=i,a?.length>=0&&a.forEach(e=>t[e]=!0))}r||=this.validationMessage,this.setValidity(t,r,n)}};H.formAssociated=!0,P([I({reflect:!0})],H.prototype,`name`,2),P([I({type:Boolean})],H.prototype,`disabled`,2),P([I({state:!0,attribute:!1})],H.prototype,`valueHasChanged`,2),P([I({state:!0,attribute:!1})],H.prototype,`hasInteracted`,2),P([I({attribute:`custom-error`,reflect:!0})],H.prototype,`customError`,2),P([I({attribute:!1,state:!0,type:Object})],H.prototype,`validity`,1);var nr=class{constructor(e,...t){this.slotNames=[],this.handleSlotChange=e=>{let t=e.target;(this.slotNames.includes(`[default]`)&&!t.name||t.name&&this.slotNames.includes(t.name))&&this.host.requestUpdate()},(this.host=e).addController(this),this.slotNames=t}hasDefaultSlot(){return this.host.childNodes?[...this.host.childNodes].some(e=>{if(e.nodeType===Node.TEXT_NODE&&e.textContent.trim()!==``)return!0;if(e.nodeType===Node.ELEMENT_NODE){let t=e;if(t.tagName.toLowerCase()===`wa-visually-hidden`)return!1;if(!t.hasAttribute(`slot`))return!0}return!1}):!1}hasNamedSlot(e){return this.host.querySelector?.(`:scope > [slot="${e}"]`)!==null}test(e,t){return t&&this.host.didSSR&&!this.host.hasUpdated?!!this.host[t]:e===`[default]`?this.hasDefaultSlot():this.hasNamedSlot(e)}hostConnected(){let e=this.host.shadowRoot;e&&`addEventListener`in e&&e.addEventListener(`slotchange`,this.handleSlotChange)}hostDisconnected(){let e=this.host.shadowRoot;e&&`removeEventListener`in e&&e.removeEventListener(`slotchange`,this.handleSlotChange)}},rr={small:`s`,medium:`m`,large:`l`},ir=new Set;function ar(e,t){t in rr&&!ir.has(`${e}:${t}`)&&(ir.add(`${e}:${t}`),console.warn(`[${e}] size="${t}" is deprecated. Use size="${rr[t]}" instead. The long-form value will be removed in the next major version.`))}var or=w`
  :host([size='xs']) {
    font-size: var(--wa-font-size-xs);
  }

  :host([size='s']),
  :host([size='small']) {
    font-size: var(--wa-font-size-s);
  }

  :host([size='m']),
  :host([size='medium']) {
    font-size: var(--wa-font-size-m);
  }

  :host([size='l']),
  :host([size='large']) {
    font-size: var(--wa-font-size-l);
  }

  :host([size='xl']) {
    font-size: var(--wa-font-size-xl);
  }
`,sr=new Set,cr=new Map,lr,ur=`ltr`,dr=`en`,fr=typeof MutationObserver<`u`&&typeof document<`u`&&document.documentElement!==void 0;if(fr){let e=new MutationObserver(mr);ur=document.documentElement.dir||`ltr`,dr=document.documentElement.lang||navigator.language,e.observe(document.documentElement,{attributes:!0,attributeFilter:[`dir`,`lang`]})}function pr(...e){e.map(e=>{let t=e.$code.toLowerCase();cr.has(t)?cr.set(t,Object.assign(Object.assign({},cr.get(t)),e)):cr.set(t,e),lr||=e}),mr()}function mr(){fr&&(ur=document.documentElement.dir||`ltr`,dr=document.documentElement.lang||navigator.language),[...sr.keys()].map(e=>{typeof e.requestUpdate==`function`&&e.requestUpdate()})}var hr=class{constructor(e){this.host=e,this.host.addController(this)}hostConnected(){sr.add(this.host)}hostDisconnected(){sr.delete(this.host)}dir(){return`${this.host.dir||ur}`.toLowerCase()}lang(){let e=`${this.host.lang||dr}`.toLowerCase().replace(/_/g,`-`);try{return new Intl.Locale(e),e}catch{return lr?lr.$code.toLowerCase():`en`}}getTranslationData(e){let t;try{t=new Intl.Locale(e.replace(/_/g,`-`))}catch{return{locale:void 0,language:``,region:``,primary:void 0,secondary:void 0}}let n=t.language.toLowerCase(),r=t.region?.toLowerCase()??``,i=cr.get(`${n}-${r}`),a=cr.get(n);return{locale:t,language:n,region:r,primary:i,secondary:a}}exists(e,t){let{primary:n,secondary:r}=this.getTranslationData(t.lang??this.lang());return t=Object.assign({includeFallback:!1},t),!!(n&&n[e]||r&&r[e]||t.includeFallback&&lr&&lr[e])}term(e,...t){let{primary:n,secondary:r}=this.getTranslationData(this.lang()),i;if(n&&n[e])i=n[e];else if(r&&r[e])i=r[e];else if(lr&&lr[e])i=lr[e];else return console.error(`No translation found for: ${String(e)}`),String(e);return typeof i==`function`?i(...t):i}date(e,t){return e=new Date(e),new Intl.DateTimeFormat(this.lang(),t).format(e)}number(e,t){return e=Number(e),isNaN(e)?``:new Intl.NumberFormat(this.lang(),t).format(e)}relativeTime(e,t,n){return new Intl.RelativeTimeFormat(this.lang(),n).format(e,t)}},gr={$code:`en`,$name:`English`,$dir:`ltr`,am:`AM`,autosizeColumn:`Autosize column`,captions:`Captions`,carousel:`Carousel`,chooseDate:`Choose date`,chooseDecade:`Choose decade`,chooseMonth:`Choose month`,chooseTime:`Choose time`,chooseYear:`Choose year`,clearEntry:`Clear entry`,clearFilter:`Clear filter`,clearSort:`Clear sort`,close:`Close`,closeCalendar:`Close calendar`,closeTimeInput:`Close time picker`,collapseRow:`Collapse row`,columnMenu:`Column options`,columnMovedToPosition:(e,t,n)=>`${e} moved to position ${t} of ${n}`,columns:`Columns`,compactPageXOfY:(e,t)=>`${e} of ${t}`,copied:`Copied`,copy:`Copy`,createOption:e=>`Create "${e}"`,currentlyPlaying:`currently playing`,currentValue:`Current value`,date:`Date`,datePickerKeyboardHelp:`Use arrow keys to change values; press Alt+Down Arrow to open the calendar.`,day:`Day`,dayPeriod:`AM/PM`,decrement:`Decrement`,deselectAllRows:`Deselect all rows`,dropFileHere:`Drop file here or click to browse`,dropFilesHere:`Drop files here or click to browse`,empty:`Empty`,endDate:`End date`,enterFullscreen:`Enter fullscreen`,error:`Error`,exitFullscreen:`Exit fullscreen`,expandRow:`Expand row`,filterByColumn:e=>`Filter by ${e}`,filterFrom:`From`,filterMax:`Max`,filterMin:`Min`,filterTo:`To`,firstPage:`First page`,goToSlide:(e,t)=>`Go to slide ${e} of ${t}`,hideColumn:`Hide column`,hidePassword:`Hide password`,hour:`Hour`,incompleteDate:`Enter a valid date.`,increment:`Increment`,jumpBackwardX:e=>`Jump back ${e} pages`,jumpForwardX:e=>`Jump forward ${e} pages`,lastPage:`Last page`,loading:`Loading`,minute:`Minute`,month:`Month`,moreOptions:`More Options`,mute:`Mute`,nextDecade:`Next decade`,nextMonth:`Next month`,nextPage:`Next page`,nextSlide:`Next slide`,nextVideo:`Next Video`,nextYear:`Next year`,noData:`No data`,noResults:`No matching results`,now:`Now`,numCharacters:e=>e===1?`1 character`:`${e} characters`,numCharactersRemaining:e=>e===1?`1 character remaining`:`${e} characters remaining`,numOptionsSelected:e=>e===0?`No options selected`:e===1?`1 option selected`:`${e} options selected`,numRowsCopied:e=>e===1?`1 row copied`:`${e} rows copied`,numRowsSelected:e=>e===1?`1 row selected`:`${e} rows selected`,pageXOfY:(e,t)=>`Page ${e} of ${t}`,pagination:`Pagination`,pause:`Pause`,pauseAnimation:`Pause animation`,pictureInPicture:`Picture in picture`,pinLeft:`Pin left`,pinRight:`Pin right`,play:`Play`,playAnimation:`Play animation`,playbackSpeed:`Playback speed`,playlist:`Playlist`,pm:`PM`,previousDecade:`Previous decade`,previousMonth:`Previous month`,previousPage:`Previous page`,previousSlide:`Previous slide`,previousVideo:`Previous video`,previousYear:`Previous year`,progress:`Progress`,rangeTooLong:e=>e===1?`Select a range no longer than 1 day`:`Select a range no longer than ${e} days`,rangeTooShort:e=>e===1?`Select a range at least 1 day long`:`Select a range at least ${e} days long`,readonly:`Read-only`,remove:`Remove`,resetColumns:`Reset columns`,resize:`Resize`,resizeColumn:`Resize column`,rowsPerPage:`Rows per page`,scrollableRegion:`Scrollable region`,scrollToEnd:`Scroll to end`,scrollToStart:`Scroll to start`,search:`Search`,second:`Second`,seek:`Seek`,seekProgress:(e,t)=>`${e} of ${t}`,selectAColorFromTheScreen:`Select a color from the screen`,selectAllRows:`Select all rows`,selected:`Selected`,selectedDateLabel:e=>`Selected: ${e}`,selectedRangeLabel:e=>`Selected range: ${e}`,selectGroup:`Select group`,selectionCleared:`Selection cleared`,selectRow:`Select row`,showingNofMRows:(e,t)=>`Showing ${e} of ${t} rows`,showingXtoYofZ:(e,t,n)=>`${e}\u2013${t} of ${n}`,showPassword:`Show password`,slideNum:e=>`Slide ${e}`,sortAscending:`Sort ascending`,sortColumn:`Sort column`,sortDescending:`Sort descending`,startDate:`Start date`,time:`Time`,timeInputKeyboardHelp:`Use arrow keys to change values; press Alt+Down Arrow to open the time picker.`,today:`Today`,toggleColorFormat:`Toggle color format`,unmute:`Unmute`,unpin:`Unpin`,unpinColumn:`Unpin column`,videoPlayer:`Video player`,volume:`Volume`,year:`Year`,zoomIn:`Zoom in`,zoomOut:`Zoom out`};pr(gr);var _r=gr,vr=class extends hr{lang(){return this.host.didSSR&&!this.host.hasUpdated?this.host.lang||`en`:super.lang()}};pr(_r);var yr={ATTRIBUTE:1,CHILD:2,PROPERTY:3,BOOLEAN_ATTRIBUTE:4,EVENT:5,ELEMENT:6},br=e=>(...t)=>({_$litDirective$:e,values:t}),xr=class{constructor(e){}get _$isConnected(){return this._$parent._$isConnected}_$initialize(e,t,n){this.__part=e,this._$parent=t,this.__attributeIndex=n}_$resolve(e,t){return this.update(e,t)}update(e,t){return this.render(...t)}},U=br(class extends xr{constructor(e){if(super(e),e.type!==yr.ATTRIBUTE||e.name!==`class`||e.strings?.length>2)throw Error("`classMap()` can only be used in the `class` attribute and must be the only part in the attribute.")}render(e){return` `+Object.keys(e).filter(t=>e[t]).join(` `)+` `}update(e,[t]){if(this._previousClasses===void 0){this._previousClasses=new Set,e.strings!==void 0&&(this._staticClasses=new Set(e.strings.join(` `).split(/\s/).filter(e=>e!==``)));for(let e in t)t[e]&&!this._staticClasses?.has(e)&&this._previousClasses.add(e);return this.render(t)}let n=e.element.classList;for(let e of this._previousClasses)e in t||(n.remove(e),this._previousClasses.delete(e));for(let e in t){let r=!!t[e];r!==this._previousClasses.has(e)&&!this._staticClasses?.has(e)&&(r?(n.add(e),this._previousClasses.add(e)):(n.remove(e),this._previousClasses.delete(e)))}return M}}),W=e=>e??N,Sr=br(class extends xr{constructor(e){if(super(e),e.type!==yr.PROPERTY&&e.type!==yr.ATTRIBUTE&&e.type!==yr.BOOLEAN_ATTRIBUTE)throw Error("The `live` directive is not allowed on child or event bindings");if(!Vn(e))throw Error("`live` bindings can only contain a single expression")}render(e){return e}update(e,[t]){if(t===M||t===N)return t;let n=e.element,r=e.name;if(e.type===yr.PROPERTY){if(t===n[r])return M}else if(e.type===yr.BOOLEAN_ATTRIBUTE){if(!!t===n.hasAttribute(r))return M}else if(e.type===yr.ATTRIBUTE&&n.getAttribute(r)===String(t))return M;return Un(e),t}}),G=class extends H{constructor(){super(...arguments),this.assumeInteractionOn=[`blur`,`input`],this.hasSlotController=new nr(this,`hint`,`label`),this.localize=new vr(this),this.title=``,this.type=`text`,this._value=null,this.defaultValue=this.getAttribute(`value`)||null,this.size=`m`,this.appearance=`outlined`,this.pill=!1,this.label=``,this.hint=``,this.withClear=!1,this.placeholder=``,this.readonly=!1,this.passwordToggle=!1,this.passwordVisible=!1,this.withoutSpinButtons=!1,this.required=!1,this.spellcheck=!0,this.withLabel=!1,this.withHint=!1}static get validators(){return[...super.validators,$n()]}get value(){return this.valueHasChanged?this._value:this._value??this.defaultValue}set value(e){this._value!==e&&(this.valueHasChanged=!0,this._value=e)}updateFormValue(e){if(e==null){this.setValue(``,null);return}super.updateFormValue(e)}handleSizeChange(){ar(this.localName,this.size)}handleChange(e){this.value=this.input.value,this.relayNativeEvent(e,{bubbles:!0,composed:!0})}handleClearClick(e){e.preventDefault(),this.value!==``&&(this.value=``,this.updateComplete.then(()=>{this.dispatchEvent(new Jn),this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0})),this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))})),this.input.focus()}handleInput(){this.value=this.input.value}handleKeyDown(e){Yn(e,this)}handlePasswordToggle(){this.passwordVisible=!this.passwordVisible}updated(e){super.updated(e),(e.has(`value`)||e.has(`defaultValue`)||e.has(`type`))&&(this.input&&[`number`,`date`,`time`,`datetime-local`].includes(this.type)&&this.value&&this.input.value!==this.value&&(this._value=this.input.value),this.customStates.set(`blank`,!this.value),this.updateValidity())}handleStepChange(){this.input.step=String(this.step),this.updateValidity()}focus(e){this.input.focus(e)}blur(){this.input.blur()}select(){this.input.select()}setSelectionRange(e,t,n=`none`){this.input.setSelectionRange(e,t,n)}setRangeText(e,t,n,r=`preserve`){let i=t??this.input.selectionStart,a=n??this.input.selectionEnd;this.input.setRangeText(e,i,a,r),this.value!==this.input.value&&(this.value=this.input.value)}showPicker(){`showPicker`in HTMLInputElement.prototype&&this.input.showPicker()}stepUp(){this.input.stepUp(),this.value!==this.input.value&&(this.value=this.input.value)}stepDown(){this.input.stepDown(),this.value!==this.input.value&&(this.value=this.input.value)}formResetCallback(){this.value=null,this.input&&(this.input.value=this.value),super.formResetCallback()}render(){let e=this.hasSlotController.test(`label`,`withLabel`),t=this.hasSlotController.test(`hint`,`withHint`),n=this.label?!0:!!e,r=this.hint?!0:!!t,i=this.withClear&&!this.disabled&&!this.readonly,a=(!this.didSSR||this.hasUpdated)&&i&&(typeof this.value==`number`||this.value&&this.value.length>0);return j`
      <label
        part="form-control-label label"
        class=${U({label:!0,"has-label":n})}
        for="input"
        aria-hidden=${n?`false`:`true`}
      >
        <slot name="label">${this.label}</slot>
      </label>

      <div part="base input-wrapper" class="text-field">
        <slot name="start" part="start" class="start"></slot>

        <input
          part="input"
          id="input"
          class="control"
          type=${this.type===`password`&&this.passwordVisible?`text`:this.type}
          title=${this.title}
          name=${W(this.name)}
          ?disabled=${this.disabled}
          ?readonly=${this.readonly}
          ?required=${this.required}
          placeholder=${W(this.placeholder)}
          minlength=${W(this.minlength)}
          maxlength=${W(this.maxlength)}
          min=${W(this.min)}
          max=${W(this.max)}
          step=${W(this.step)}
          .value=${Sr(this.value??``)}
          autocapitalize=${W(this.autocapitalize)}
          autocomplete=${W(this.autocomplete)}
          autocorrect=${this.autocorrect?`on`:`off`}
          ?autofocus=${this.autofocus}
          spellcheck=${this.spellcheck}
          pattern=${W(this.pattern)}
          enterkeyhint=${W(this.enterkeyhint)}
          inputmode=${W(this.inputmode)}
          aria-describedby="hint"
          @change=${this.handleChange}
          @input=${this.handleInput}
          @keydown=${this.handleKeyDown}
        />

        ${a?j`
              <button
                part="clear-button"
                class="clear"
                type="button"
                aria-label=${this.localize.term(`clearEntry`)}
                @click=${this.handleClearClick}
                tabindex="-1"
              >
                <slot name="clear-icon">
                  <wa-icon name="circle-xmark" library="system" variant="regular"></wa-icon>
                </slot>
              </button>
            `:``}
        ${this.passwordToggle&&!this.disabled?j`
              <button
                part="password-toggle-button"
                class="password-toggle"
                type="button"
                aria-label=${this.localize.term(this.passwordVisible?`hidePassword`:`showPassword`)}
                @click=${this.handlePasswordToggle}
                tabindex="-1"
              >
                ${this.passwordVisible?j`
                      <slot name="hide-password-icon">
                        <wa-icon name="eye-slash" library="system" variant="regular"></wa-icon>
                      </slot>
                    `:j`
                      <slot name="show-password-icon">
                        <wa-icon name="eye" library="system" variant="regular"></wa-icon>
                      </slot>
                    `}
              </button>
            `:``}

        <slot name="end" part="end" class="end"></slot>
      </div>

      <slot
        id="hint"
        part="hint"
        name="hint"
        class=${U({"has-slotted":r})}
        aria-hidden=${r?`false`:`true`}
        >${this.hint}</slot
      >
    `}};G.css=[or,Qn,Zn],G.shadowRootOptions={...H.shadowRootOptions,delegatesFocus:!0},P([R(`input`)],G.prototype,`input`,2),P([I()],G.prototype,`title`,2),P([I({reflect:!0})],G.prototype,`type`,2),P([L()],G.prototype,`value`,1),P([I({attribute:`value`,reflect:!0})],G.prototype,`defaultValue`,2),P([I({reflect:!0})],G.prototype,`size`,2),P([B(`size`)],G.prototype,`handleSizeChange`,1),P([I({reflect:!0})],G.prototype,`appearance`,2),P([I({type:Boolean,reflect:!0})],G.prototype,`pill`,2),P([I()],G.prototype,`label`,2),P([I({attribute:`hint`})],G.prototype,`hint`,2),P([I({attribute:`with-clear`,type:Boolean})],G.prototype,`withClear`,2),P([I()],G.prototype,`placeholder`,2),P([I({type:Boolean,reflect:!0})],G.prototype,`readonly`,2),P([I({attribute:`password-toggle`,type:Boolean})],G.prototype,`passwordToggle`,2),P([I({attribute:`password-visible`,type:Boolean})],G.prototype,`passwordVisible`,2),P([I({attribute:`without-spin-buttons`,type:Boolean,reflect:!0})],G.prototype,`withoutSpinButtons`,2),P([I({type:Boolean,reflect:!0})],G.prototype,`required`,2),P([I()],G.prototype,`pattern`,2),P([I({type:Number})],G.prototype,`minlength`,2),P([I({type:Number})],G.prototype,`maxlength`,2),P([I()],G.prototype,`min`,2),P([I()],G.prototype,`max`,2),P([I()],G.prototype,`step`,2),P([I()],G.prototype,`autocapitalize`,2),P([I({type:Boolean,converter:{fromAttribute:e=>!(!e||e===`off`),toAttribute:e=>e?`on`:`off`}})],G.prototype,`autocorrect`,2),P([I()],G.prototype,`autocomplete`,2),P([I({type:Boolean})],G.prototype,`autofocus`,2),P([I()],G.prototype,`enterkeyhint`,2),P([I({type:Boolean,converter:{fromAttribute:e=>!(!e||e===`false`),toAttribute:e=>e?`true`:`false`}})],G.prototype,`spellcheck`,2),P([I()],G.prototype,`inputmode`,2),P([I({attribute:`with-label`,type:Boolean})],G.prototype,`withLabel`,2),P([I({attribute:`with-hint`,type:Boolean})],G.prototype,`withHint`,2),P([B(`step`,{waitUntilFirstUpdate:!0})],G.prototype,`handleStepChange`,1),G=P([F(`wa-input`)],G),G.disableWarning?.(`change-in-update`);var Cr=class extends Event{constructor(){super(`wa-complete`,{bubbles:!0,cancelable:!0,composed:!0})}},wr=w`
  :host(:focus) {
    outline: none;
  }

  /* Segments container */
  .segments {
    position: relative;
    /* Codes read left-to-right regardless of locale — keep segment order and caret movement LTR
       even when the surrounding page is RTL. */
    direction: ltr;
    display: inline-flex;
    align-items: center;
    align-self: start;
    gap: var(--segment-gap, var(--wa-space-xs));
    cursor: text;
    /* Never grow past the host's available width — long values or large segment sizes scroll
       horizontally instead of overflowing the page. */
    max-width: 100%;
    overflow-x: auto;
    scrollbar-width: none;
    /* Setting overflow-x forces overflow-y to also compute to non-visible, which would otherwise
       clip the focus ring's bleed around the active segment — above/below for any segment, and
       left/right for the first/last segment specifically. Reserve room for it with padding, then
       cancel the layout impact with an equal negative margin on both axes. */
    padding: calc(var(--wa-focus-ring-offset) + var(--wa-focus-ring-width));
    margin: calc(-1 * (var(--wa-focus-ring-offset) + var(--wa-focus-ring-width)));
  }

  .segments::-webkit-scrollbar {
    width: 0;
    height: 0;
  }

  :host(:state(disabled)) .segments {
    cursor: not-allowed;
    opacity: 0.5;
  }

  :host(:state(readonly)) .segments {
    cursor: default;
  }

  /* Focus ring on the active segment, and on every segment in a multi-character selection */
  .segments:focus-within .segment--active,
  .segments:focus-within .segment--selected {
    outline: var(--wa-focus-ring-style) var(--wa-focus-ring-width) var(--wa-color-focus);
    outline-offset: var(--wa-focus-ring-offset);
  }

  /* Readonly has no per-segment active/selected state (see render()), so every segment rings
     at once to show the control as a whole has focus. */
  :host(:state(readonly)) .segments:focus-within .segment {
    outline: var(--wa-focus-ring-style) var(--wa-focus-ring-width) var(--wa-color-focus);
    outline-offset: var(--wa-focus-ring-offset);
  }

  /* Contained segments sit flush with zero gap and have no border of their own, so a ring drawn
     outside the segment edge (the default, positive offset) bleeds into the neighboring segment.
     Draw it inward instead so it stays within this segment's own box. */
  :host([appearance='contained']) .segments:focus-within .segment--active,
  :host([appearance='contained']) .segments:focus-within .segment--selected,
  :host([appearance='contained']:state(readonly)) .segments:focus-within .segment {
    outline-offset: calc(-1 * var(--wa-focus-ring-width));
  }

  /* Hidden real input — off-screen but focusable.
     Chromium mishandles typing over a full selection (drops the inserted character) when a
     text input has zero layout size, so this stays a non-zero 1x1px box instead of 0x0. */
  .hidden-input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
    overflow: hidden;
    pointer-events: none;
    border: none;
    padding: 0;
    margin: 0;
  }

  /* Individual visual segment */
  .segment {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    width: var(--segment-size, 2.5em);
    height: var(--segment-size, 2.5em);
    border-radius: var(--segment-border-radius, var(--wa-form-control-border-radius));
    font-size: 1em;
    font-family: inherit;
    font-variant-numeric: tabular-nums;
    position: relative;
    user-select: none;
    /* Zero-width outline present at all times so the focus ring can grow in smoothly
       instead of popping in the instant .segment--active/--selected starts matching. */
    outline: var(--wa-focus-ring-style) 0 var(--wa-color-focus);
    transition:
      background-color var(--wa-transition-normal),
      border-color var(--wa-transition-normal),
      outline-color var(--wa-transition-fast),
      outline-width var(--wa-transition-fast),
      outline-offset var(--wa-transition-fast);
    transition-timing-function: var(--wa-transition-easing);
  }

  /* Blinking caret in the active segment */
  .caret {
    position: absolute;
    width: 1.5px;
    height: 60%;
    background-color: currentColor;
    animation: wa-otp-caret-blink 1s step-end infinite;
  }

  @keyframes wa-otp-caret-blink {
    0%,
    100% {
      opacity: 1;
    }
    50% {
      opacity: 0;
    }
  }

  /* Literal separator character between segment groups */
  .segment-literal {
    display: inline-block;
    flex-shrink: 0;
    color: var(--wa-color-text-quiet);
    white-space: pre;
    user-select: none;
  }

  /* Appearance: outlined (default) */
  :host([appearance='outlined']) .segment,
  :host(:not([appearance])) .segment {
    background-color: var(--wa-form-control-background-color);
    border: var(--wa-form-control-border-width) var(--wa-form-control-border-style) var(--wa-form-control-border-color);
  }

  /* Appearance: filled */
  :host([appearance='filled']) .segment {
    background-color: var(--wa-color-neutral-fill-quiet);
    border: var(--wa-form-control-border-width) var(--wa-form-control-border-style) transparent;
  }

  /* Appearance: filled-outlined */
  :host([appearance='filled-outlined']) .segment {
    background-color: var(--wa-color-neutral-fill-quiet);
    border: var(--wa-form-control-border-width) var(--wa-form-control-border-style) var(--wa-form-control-border-color);
  }

  /* Appearance: contained */
  :host([appearance='contained']) .segments {
    gap: 0;
    border: var(--wa-form-control-border-width) var(--wa-form-control-border-style) var(--wa-form-control-border-color);
    border-radius: var(--segment-border-radius, var(--wa-form-control-border-radius));
    background-color: var(--wa-form-control-background-color);
    overflow: hidden;
    /* The focus ring is drawn inward here (see outline-offset above), so there's no outward bleed
       to reserve room for. .segments is also the visible bordered box in this appearance, so the
       padding/negative-margin bleed trick from the base rule would visibly shift and inflate it. */
    padding: 0;
    margin: 0;
  }

  :host([appearance='contained']) .segment {
    border: none;
    border-radius: 0;
  }

  /* Dividers between contained segments */
  :host([appearance='contained']) .segment + .segment,
  :host([appearance='contained']) .segment-literal + .segment {
    border-left: var(--wa-form-control-border-width) var(--wa-form-control-border-style)
      var(--wa-form-control-border-color);
  }

  /* ── Active segment (where next char will go), and every segment in a multi-character
     selection (e.g. from Cmd/Ctrl+A) — same border + focus-ring treatment for both.
     :host(...) wrapper matches the specificity of the appearance rules above so this
     border-color isn't silently lost to the cascade. ── */
  :host(:not(:state(readonly))) .segment--active,
  :host(:not(:state(readonly))) .segment--selected {
    border-color: var(--wa-color-focus);
  }

  /* Masked filled character, and the empty-segment hint shown when with-mask is set, both draw
     --mask-char via a pseudo-element instead of real text, so a masked value never touches the
     DOM as plain text (nothing to find via view-source or copy). */
  .segment--masked::before,
  .segment--mask-hint::before {
    content: var(--mask-char, '•');
  }

  .segment--mask-hint::before {
    opacity: 0.35;
  }
`;function Tr(e,t){return{top:Math.round(e.getBoundingClientRect().top-t.getBoundingClientRect().top),left:Math.round(e.getBoundingClientRect().left-t.getBoundingClientRect().left)}}function Er(e,t,n=`vertical`,r=`smooth`){let i=Tr(e,t),a=i.top+t.scrollTop,o=i.left+t.scrollLeft,s=t.scrollLeft,c=t.scrollLeft+t.offsetWidth,l=t.scrollTop,u=t.scrollTop+t.offsetHeight;(n===`horizontal`||n===`both`)&&(o<s?t.scrollTo({left:o,behavior:r}):o+e.clientWidth>c&&t.scrollTo({left:o-t.offsetWidth+e.clientWidth,behavior:r})),(n===`vertical`||n===`both`)&&(a<l?t.scrollTo({top:a,behavior:r}):a+e.clientHeight>u&&t.scrollTo({top:a-t.offsetHeight+e.clientHeight,behavior:r}))}var K=class extends H{constructor(){super(...arguments),this.hasSlotController=new nr(this,`label`,`hint`),this._focused=!1,this._activeIndex=-1,this._selectionAnchor=-1,this._pendingClickIndex=null,this._value=``,this.defaultValue=this.getAttribute(`value`)??null,this.length=6,this.appearance=`outlined`,this.type=`numeric`,this.mask=!1,this.case=`preserve`,this.size=`m`,this.label=``,this.hint=``,this.format=``,this.autocomplete=`one-time-code`,this.required=!1,this.readonly=!1,this.autosubmit=!1,this.autofocus=!1,this.withMask=!1,this.assumeInteractionOn=[`blur`,`input`],this._lastChangeValue=``}static get validators(){return[...super.validators,$n()]}get validationTarget(){return this.segmentsContainer}get hasSelection(){return this._selectionAnchor>=0&&this._selectionAnchor!==this._activeIndex}setCaretIndex(e){this._activeIndex=e,this._selectionAnchor=-1}get value(){return this._value}set value(e){let t=this.filterAndTransform(e).slice(0,this.effectiveLength);if(this._value===t)return;let n=this._value;this._value=t,this.setValue(t),this.input&&(this.input.value=t),this._focused&&this.setCaretIndex(Math.min(t.length,this.effectiveLength-1)),this.requestUpdate(`value`,n)}handleSizeChange(){ar(this.localName,this.size)}get effectiveLength(){return this.format?[...this.format].filter(e=>e===`#`).length:this.length}get parsedFormat(){return[...this.format||`#`.repeat(this.length)].map(e=>({type:e===`#`?`segment`:`separator`,char:e}))}filterAndTransform(e){let t=e;return this.type===`numeric`?t=t.replace(/\D/g,``):this.type===`alpha`?t=t.replace(/[^a-zA-Z]/g,``):this.type===`alphanumeric`&&(t=t.replace(/[^a-zA-Z0-9]/g,``)),this.case===`upper`?t=t.toUpperCase():this.case===`lower`&&(t=t.toLowerCase()),t}willUpdate(e){if(super.willUpdate(e),!this.hasUpdated){let e=this.filterAndTransform(this.defaultValue??``).slice(0,this.effectiveLength);this._value!==e&&(this._value=e,this.setValue(e),this._lastChangeValue=e)}if(this.hasUpdated&&(e.has(`type`)||e.has(`case`)||e.has(`length`)||e.has(`format`))){let e=this.filterAndTransform(this._value).slice(0,this.effectiveLength);e!==this._value&&(this._value=e,this.setValue(e),this.input&&(this.input.value=e))}}updated(e){super.updated(e);let t=this._value;this.customStates.set(`--blank`,t.length===0),this.customStates.set(`--filled`,t.length===this.effectiveLength),this.customStates.set(`readonly`,this.readonly),(e.has(`value`)||e.has(`required`)||e.has(`length`)||e.has(`format`))&&this.updateValidity(),this.syncCursor();let n=this.segmentsContainer?.querySelector(`.segment--active, .segment--selected`);n&&this.segmentsContainer&&Er(n,this.segmentsContainer,`horizontal`,`auto`)}syncCursor(){if(!this._focused||!this.input||this._activeIndex<0||this.hasSelection)return;let e=this._value.length,t=Math.min(this._activeIndex,e),n=this._activeIndex<e?t+1:t;this.input.setSelectionRange(t,n)}formResetCallback(){super.formResetCallback();let e=this.filterAndTransform(this.defaultValue??``).slice(0,this.effectiveLength),t=this._value;this._value=e,this.setValue(e),this._lastChangeValue=e,this.input&&(this.input.value=e),this.requestUpdate(`value`,t)}handleInput(e){if(this.readonly)return;let t=e.target,n=t.value,r=t.selectionStart??n.length,i=this.filterAndTransform(n).slice(0,this.effectiveLength),a=r;if(n!==i){t.value=i;let e=n.slice(0,r);a=Math.min(this.filterAndTransform(e).length,this.effectiveLength)}this.setCaretIndex(Math.min(a,this.effectiveLength-1));let o=this._value.length,s=this._value;this._value=i,this.setValue(i),this.maybeDispatchComplete(i.length===this.effectiveLength&&o<this.effectiveLength),this.requestUpdate(`value`,s)}maybeDispatchComplete(e){if(!e)return;let t=this.dispatchEvent(new Cr);this.autosubmit&&t&&setTimeout(()=>Xn(this))}handleKeyDown(e){if(e.isComposing)return;let t=this.effectiveLength;if(e.key===`Enter`)Yn(e,this);else if(this.readonly)(e.key===`Backspace`||e.key===`Delete`)&&e.preventDefault();else if(e.key===`ArrowRight`)e.preventDefault(),this.hasSelection?this.setCaretIndex(Math.min(Math.max(this._selectionAnchor,this._activeIndex),t-1)):this._activeIndex=Math.min(this._activeIndex+1,t-1);else if(e.key===`ArrowLeft`)e.preventDefault(),this.hasSelection?this.setCaretIndex(Math.max(Math.min(this._selectionAnchor,this._activeIndex),0)):this._activeIndex=Math.max(this._activeIndex-1,0);else if(e.key===`Backspace`){if(e.preventDefault(),this.hasSelection){let e=Math.min(this._selectionAnchor,this._activeIndex),n=Math.max(this._selectionAnchor,this._activeIndex);this.spliceValue(e,n),this.setCaretIndex(Math.min(e,t-1))}else{let e=this._activeIndex;e<this._value.length&&this.spliceValue(e),this.setCaretIndex(Math.max(e-1,0))}}else if(e.key===`Delete`){if(e.preventDefault(),this.hasSelection){let e=Math.min(this._selectionAnchor,this._activeIndex),n=Math.max(this._selectionAnchor,this._activeIndex);this.spliceValue(e,n),this.setCaretIndex(Math.min(e,t-1))}else{let e=this._activeIndex;e<this._value.length&&this.spliceValue(e)}}}spliceValue(e,t=e+1){let n=this._value.slice(0,e)+this._value.slice(t),r=this._value;this._value=n,this.setValue(n),this.input&&(this.input.value=n),this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0})),this.requestUpdate(`value`,r)}handlePaste(e){if(e.preventDefault(),this.readonly)return;let t=e.clipboardData?.getData(`text/plain`)??``,n=this.filterAndTransform(t);if(!n)return;let r=this._activeIndex,i=this.effectiveLength,a=Array.from({length:i},(e,t)=>this._value[t]??``);for(let e=0;e<n.length&&r+e<i;e++)a[r+e]=n[e];let o=i-1;for(;o>=0&&!a[o];)o--;let s=o>=0?a.slice(0,o+1).join(``):``,c=this._value.length,l=this._value;this._value=s,this.setValue(s),this.input&&(this.input.value=s),this.setCaretIndex(Math.min(r+n.length,i-1)),this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0})),this.maybeDispatchComplete(s.length===i&&c<i),this.requestUpdate(`value`,l)}handleFocus(){this._focused=!0,this.setCaretIndex(this._pendingClickIndex??Math.min(this._value.length,this.effectiveLength-1))}handleSelect(){if(!this.input)return;let e=this.input.selectionStart??0,t=this.input.selectionEnd??e;t-e>1?(this._selectionAnchor=e,this._activeIndex=t):this._selectionAnchor!==-1&&(this._selectionAnchor=-1)}handleBlur(){this._focused=!1,this.setCaretIndex(-1),this._value!==this._lastChangeValue&&(this._lastChangeValue=this._value,this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0})))}segmentIndexAt(e){let t=e.closest(`[part~="segment"]`);if(!t||!this.shadowRoot)return null;let n=[...this.shadowRoot.querySelectorAll(`[part~="segment"]`)].indexOf(t);return n>=0?Math.min(n,this._value.length):null}handleSegmentsPointerDown(e){this.disabled||(this._pendingClickIndex=this.segmentIndexAt(e.target))}handleSegmentsClick(e){if(this.disabled)return;this.input?.focus();let t=this.segmentIndexAt(e.target);t!==null&&this.setCaretIndex(t),this._pendingClickIndex=null}clear(){this.value=``,this.dispatchEvent(new Jn),this.focus()}focus(e){this.input?.focus(e)}blur(){this.input?.blur()}select(){this.input?.select()}render(){let e=this.hasSlotController.test(`label`),t=this.hasSlotController.test(`hint`),n=this.label?!0:!!e,r=this.hint?!0:!!t,i=[...this._value],a=this.parsedFormat,o=this._activeIndex,s=this.hasSelection?[Math.min(this._selectionAnchor,o),Math.max(this._selectionAnchor,o)]:null,c=0;return j`
      <label
        id="label"
        part="label"
        class=${U({label:!0,"has-label":n})}
        for="hidden-input"
        aria-hidden=${n?`false`:`true`}
      >
        <slot name="label">${this.label}</slot>
      </label>

      <div
        part="segments"
        class="segments"
        role="group"
        aria-labelledby="label"
        @pointerdown=${this.handleSegmentsPointerDown}
        @click=${this.handleSegmentsClick}
      >
        ${a.map(e=>{if(e.type===`separator`)return j`<span part="segment-literal" class="segment-literal" aria-hidden="true">${e.char}</span>`;let t=c++,n=i[t]??``,r=!!n,a=!this.readonly&&s!==null&&t>=s[0]&&t<s[1],l=!this.readonly&&s===null&&t===o,u=r&&this.mask;return j`
            <div
              part="segment"
              class=${U({segment:!0,"segment--active":l,"segment--selected":a,"segment--filled":r,"segment--masked":u,"segment--mask-hint":!r&&this.withMask})}
              aria-hidden="true"
            >
              ${u?``:n} ${l&&!n?j`<span class="caret"></span>`:``}
            </div>
          `})}

        <input
          id="hidden-input"
          class="hidden-input"
          type="text"
          .value=${Sr(this._value)}
          minlength=${this.effectiveLength}
          autocomplete=${this.autocomplete}
          inputmode=${this.type===`numeric`?`numeric`:`text`}
          aria-describedby="hint"
          ?required=${this.required}
          ?disabled=${this.disabled}
          ?readonly=${this.readonly}
          ?autofocus=${this.autofocus}
          @input=${this.handleInput}
          @keydown=${this.handleKeyDown}
          @paste=${this.handlePaste}
          @focus=${this.handleFocus}
          @blur=${this.handleBlur}
          @select=${this.handleSelect}
        />
      </div>

      <slot
        id="hint"
        part="hint"
        name="hint"
        class=${U({hint:!0,"has-slotted":r})}
        aria-hidden=${r?`false`:`true`}
        >${this.hint}</slot
      >
    `}};K.shadowRootOptions={...H.shadowRootOptions,delegatesFocus:!0},K.css=[or,Qn,wr],P([R(`.hidden-input`)],K.prototype,`input`,2),P([R(`.segments`)],K.prototype,`segmentsContainer`,2),P([L()],K.prototype,`_focused`,2),P([L()],K.prototype,`_activeIndex`,2),P([L()],K.prototype,`_selectionAnchor`,2),P([I({attribute:`value`,reflect:!0})],K.prototype,`defaultValue`,2),P([I({type:Number,reflect:!0})],K.prototype,`length`,2),P([I({reflect:!0})],K.prototype,`appearance`,2),P([I({reflect:!0})],K.prototype,`type`,2),P([I({type:Boolean,reflect:!0})],K.prototype,`mask`,2),P([I({reflect:!0})],K.prototype,`case`,2),P([I({reflect:!0})],K.prototype,`size`,2),P([B(`size`)],K.prototype,`handleSizeChange`,1),P([I()],K.prototype,`label`,2),P([I()],K.prototype,`hint`,2),P([I()],K.prototype,`format`,2),P([I({reflect:!0})],K.prototype,`autocomplete`,2),P([I({type:Boolean,reflect:!0})],K.prototype,`required`,2),P([I({type:Boolean,reflect:!0})],K.prototype,`readonly`,2),P([I({type:Boolean,reflect:!0})],K.prototype,`autosubmit`,2),P([I({type:Boolean})],K.prototype,`autofocus`,2),P([I({type:Boolean,attribute:`with-mask`,reflect:!0})],K.prototype,`withMask`,2),K=P([F(`wa-otp-input`)],K),K.disableWarning?.(`change-in-update`);var Dr=w`
  :host {
    border-width: 0;
  }

  .textarea {
    display: grid;
    align-items: center;
    margin: 0;
    border: none;
    outline: none;
    cursor: inherit;
    font: inherit;
    background-color: var(--wa-form-control-background-color);
    border-color: var(--wa-form-control-border-color);
    border-radius: var(--wa-form-control-border-radius);
    border-style: var(--wa-form-control-border-style);
    border-width: var(--wa-form-control-border-width);
    -webkit-appearance: none;
    outline: var(--wa-focus-ring-style) var(--wa-focus-ring-width) transparent;
    outline-offset: var(--wa-focus-ring-offset);

    &:focus-within {
      outline-color: var(--wa-color-focus);
    }

    /* Style disabled textareas */
    &:has(:disabled) {
      cursor: not-allowed;
      opacity: 0.5;
    }
  }

  /* Appearance modifiers */
  :host([appearance='outlined']) .textarea {
    background-color: var(--wa-form-control-background-color);
    border-color: var(--wa-form-control-border-color);
  }

  :host([appearance='filled']) .textarea {
    background-color: var(--wa-color-neutral-fill-quiet);
    border-color: var(--wa-color-neutral-fill-quiet);
  }

  :host([appearance='filled-outlined']) .textarea {
    background-color: var(--wa-color-neutral-fill-quiet);
    border-color: var(--wa-form-control-border-color);
  }

  textarea {
    display: block;
    width: 100%;
    border: none;
    background: transparent;
    font: inherit;
    color: inherit;
    cursor: inherit;
    scroll-padding-block: var(--wa-form-control-padding-block);
    padding: calc(var(--wa-form-control-padding-block) - ((1lh - 1em) / 2)) var(--wa-form-control-padding-inline); /* accounts for the larger line height of textarea content */
    min-height: calc(var(--wa-form-control-height) - var(--border-width) * 2);
    box-shadow: none;
    margin: 0;

    &::placeholder {
      color: var(--wa-form-control-placeholder-color);
      user-select: none;
      -webkit-user-select: none;
    }

    &:autofill {
      &,
      &:hover,
      &:focus,
      &:active {
        box-shadow: none;
        caret-color: var(--wa-form-control-value-color);
      }
    }

    &:focus {
      outline: none;
    }
  }

  /* Shared textarea and size-adjuster positioning */
  .control,
  .size-adjuster {
    grid-area: 1 / 1 / 2 / 2;
  }

  .size-adjuster {
    visibility: hidden;
    pointer-events: none;
    opacity: 0;
    padding: 0;
  }

  textarea::-webkit-search-decoration,
  textarea::-webkit-search-cancel-button,
  textarea::-webkit-search-results-button,
  textarea::-webkit-search-results-decoration {
    -webkit-appearance: none;
  }

  /*
   * Resize types
   */

  :host([resize='none']) textarea {
    resize: none;
  }

  textarea,
  :host([resize='vertical']) textarea {
    resize: vertical;
  }

  :host([resize='horizontal']) textarea {
    resize: horizontal;
  }

  :host([resize='both']) textarea {
    resize: both;
  }

  :host([resize='auto']) textarea {
    height: auto;
    resize: none;
    overflow-y: hidden;
  }

  /*
   * Footer (hint + character count)
   */

  .footer {
    display: flex;
    align-items: baseline;
    gap: 1em;
  }

  .footer.has-count [part='hint'] {
    flex: 1 1 auto;
    min-width: 0;
  }

  .count {
    flex: 0 0 auto;
    color: var(--wa-form-control-hint-color);
    font-weight: var(--wa-form-control-hint-font-weight);
    line-height: var(--wa-form-control-hint-line-height);
    margin-block-start: 0.5em;
    font-size: var(--wa-font-size-smaller);
    margin-inline-start: auto;
  }
`,Or=w`
  .wa-visually-hidden:not(:focus-within),
  .wa-visually-hidden-force,
  .wa-visually-hidden-hint::part(hint),
  .wa-visually-hidden-label::part(label),
  .wa-visually-hidden-label::part(form-control-label) {
    position: absolute !important;
    width: 1px !important;
    height: 1px !important;
    clip: rect(0 0 0 0) !important;
    clip-path: inset(50%) !important;
    border: none !important;
    overflow: hidden !important;
    white-space: nowrap !important;
    padding: 0 !important;
  }
`,q=class extends H{constructor(){super(...arguments),this.assumeInteractionOn=[`blur`,`input`],this.hasSlotController=new nr(this,`hint`,`label`),this.localize=new vr(this),this.announcedCountText=``,this.title=``,this.name=null,this._value=null,this.defaultValue=this.getAttribute(`value`)??``,this.size=`m`,this.appearance=`outlined`,this.label=``,this.hint=``,this.placeholder=``,this.rows=4,this.resize=`vertical`,this.disabled=!1,this.readonly=!1,this.required=!1,this.spellcheck=!0,this.withLabel=!1,this.withHint=!1,this.withCount=!1,this.lastObservedWidth=0}static get validators(){return[...super.validators,$n()]}get value(){return this.valueHasChanged?this._value:this._value??this.defaultValue}set value(e){this._value!==e&&(this.valueHasChanged=!0,this._value=e)}handleSizeChange(){ar(this.localName,this.size)}connectedCallback(){super.connectedCallback(),this.updateComplete.then(()=>{if(this.setTextareaDimensions(),this.updateResizeObserver(),this.didSSR&&this.input&&this.value!==this.input.value){let e=this.input.value;this.value=e}})}disconnectedCallback(){super.disconnectedCallback(),clearTimeout(this.countAnnounceTimeout),this.resizeObserver?.disconnect(),this.resizeObserver=void 0}updateFormValue(e){if(e==null){this.setValue(``,null);return}super.updateFormValue(e)}updateResizeObserver(){let e=this.resize!==`none`;this.resizeObserver&&=(this.resizeObserver.disconnect(),void 0),e&&this.input&&(this.resize===`auto`?(this.resizeObserver=new ResizeObserver(e=>{let t=e[0]?.contentRect.width??0;t!==this.lastObservedWidth&&(this.lastObservedWidth=t,requestAnimationFrame(()=>this.setTextareaDimensions()))}),this.resizeObserver.observe(this)):(this.resizeObserver=new ResizeObserver(()=>this.setTextareaDimensions()),this.resizeObserver.observe(this.input)))}handleBlur(){this.checkValidity()}handleChange(e){this.valueHasChanged=!0,this.value=this.input.value,this.setTextareaDimensions(),this.checkValidity(),this.relayNativeEvent(e,{bubbles:!0,composed:!0})}handleInput(e){this.valueHasChanged=!0,this.value=this.input.value,this.relayNativeEvent(e,{bubbles:!0,composed:!0}),this.scheduleCountAnnouncement()}scheduleCountAnnouncement(){clearTimeout(this.countAnnounceTimeout),this.countAnnounceTimeout=setTimeout(()=>{let e=(this.value??``).length;this.announcedCountText=this.maxlength==null?this.localize.term(`numCharacters`,e):this.localize.term(`numCharactersRemaining`,this.maxlength-e)},1e3)}setTextareaDimensions(){if(this.resize===`none`){this.base.style.width=``,this.base.style.height=``;return}if(this.resize===`auto`){this.sizeAdjuster.style.height=`${this.input.clientHeight}px`,this.input.style.height=`auto`;let e=this.input.scrollHeight;this.input.style.height=`${e}px`,this.sizeAdjuster.style.height=`${e}px`,this.base.style.width=``,this.base.style.height=``;return}if(this.input.style.width){let e=Number(this.input.style.width.split(/px/)[0])+2;this.base.style.width=`${e}px`}if(this.input.style.height){let e=Number(this.input.style.height.split(/px/)[0])+2;this.base.style.height=`${e}px`}}handleRowsChange(){this.setTextareaDimensions()}async handleValueChange(){await this.updateComplete,this.checkValidity(),this.setTextareaDimensions()}updated(e){e.has(`resize`)&&(this.setTextareaDimensions(),this.updateResizeObserver()),super.updated(e),e.has(`value`)&&this.customStates.set(`blank`,!this.value)}focus(e){this.input.focus(e)}blur(){this.input.blur()}select(){this.input.select()}scrollPosition(e){if(e){typeof e.top==`number`&&(this.input.scrollTop=e.top),typeof e.left==`number`&&(this.input.scrollLeft=e.left);return}return{top:this.input.scrollTop,left:this.input.scrollTop}}setSelectionRange(e,t,n=`none`){this.input.setSelectionRange(e,t,n)}setRangeText(e,t,n,r=`preserve`){let i=t??this.input.selectionStart,a=n??this.input.selectionEnd;this.input.setRangeText(e,i,a,r),this.value!==this.input.value&&(this.value=this.input.value,this.setTextareaDimensions())}formResetCallback(){this._value=null,this.input&&(this.input.value=this.value||``),super.formResetCallback()}render(){let e=this.hasSlotController.test(`label`,`withLabel`),t=this.hasSlotController.test(`hint`,`withHint`),n=this.label?!0:!!e,r=this.hint?!0:!!t,i=(this.value??``).length,a=this.maxlength==null?this.localize.term(`numCharacters`,i):this.localize.term(`numCharactersRemaining`,this.maxlength-i);return j`
      <label
        part="form-control-label label"
        class=${U({label:!0,"has-label":n})}
        for="input"
        aria-hidden=${n?`false`:`true`}
      >
        <slot name="label">${this.label}</slot>
      </label>

      <div part="base textarea-wrapper" class="textarea">
        <textarea
          part="textarea"
          id="input"
          class="control"
          title=${this.title}
          name=${W(this.name)}
          .value=${Sr(this.value)}
          ?disabled=${this.disabled}
          ?readonly=${this.readonly}
          ?required=${this.required}
          placeholder=${W(this.placeholder)}
          rows=${W(this.rows)}
          minlength=${W(this.minlength)}
          maxlength=${W(this.maxlength)}
          autocapitalize=${W(this.autocapitalize)}
          autocorrect=${W(this.autocorrect)}
          ?autofocus=${this.autofocus}
          spellcheck=${W(this.spellcheck)}
          enterkeyhint=${W(this.enterkeyhint)}
          inputmode=${W(this.inputmode)}
          aria-describedby="hint"
          @change=${this.handleChange}
          @input=${this.handleInput}
          @blur=${this.handleBlur}
        ></textarea>

        <!-- This "adjuster" exists to prevent layout shifting. https://github.com/shoelace-style/shoelace/issues/2180 -->
        <div part="textarea-adjuster" class="size-adjuster" ?hidden=${this.resize!==`auto`}></div>
      </div>

      <div
        class=${U({footer:!0,"has-count":this.withCount})}
      >
        <slot
          id="hint"
          name="hint"
          part="hint"
          aria-hidden=${r?`false`:`true`}
          class=${U({"has-slotted":r})}
          >${this.hint}</slot
        >

        ${this.withCount?j`
              <div part="count" class="count" aria-hidden="true">${a}</div>
              <div class="wa-visually-hidden-force" aria-live="polite">${this.announcedCountText}</div>
            `:``}
      </div>
    `}};q.css=[Dr,Qn,or,Or],P([L()],q.prototype,`announcedCountText`,2),P([R(`.control`)],q.prototype,`input`,2),P([R(`[part~="base"]`)],q.prototype,`base`,2),P([R(`.size-adjuster`)],q.prototype,`sizeAdjuster`,2),P([I()],q.prototype,`title`,2),P([I({reflect:!0})],q.prototype,`name`,2),P([L()],q.prototype,`value`,1),P([I({attribute:`value`,reflect:!0})],q.prototype,`defaultValue`,2),P([I({reflect:!0})],q.prototype,`size`,2),P([B(`size`)],q.prototype,`handleSizeChange`,1),P([I({reflect:!0})],q.prototype,`appearance`,2),P([I()],q.prototype,`label`,2),P([I({attribute:`hint`})],q.prototype,`hint`,2),P([I()],q.prototype,`placeholder`,2),P([I({type:Number})],q.prototype,`rows`,2),P([I({reflect:!0})],q.prototype,`resize`,2),P([I({type:Boolean})],q.prototype,`disabled`,2),P([I({type:Boolean,reflect:!0})],q.prototype,`readonly`,2),P([I({type:Boolean,reflect:!0})],q.prototype,`required`,2),P([I({type:Number})],q.prototype,`minlength`,2),P([I({type:Number})],q.prototype,`maxlength`,2),P([I()],q.prototype,`autocapitalize`,2),P([I({type:Boolean,converter:{fromAttribute:e=>!(!e||e===`off`),toAttribute:e=>e?`on`:`off`}})],q.prototype,`autocorrect`,2),P([I()],q.prototype,`autocomplete`,2),P([I({type:Boolean})],q.prototype,`autofocus`,2),P([I()],q.prototype,`enterkeyhint`,2),P([I({type:Boolean,converter:{fromAttribute:e=>!(!e||e===`false`),toAttribute:e=>e?`true`:`false`}})],q.prototype,`spellcheck`,2),P([I()],q.prototype,`inputmode`,2),P([I({attribute:`with-label`,type:Boolean})],q.prototype,`withLabel`,2),P([I({attribute:`with-hint`,type:Boolean})],q.prototype,`withHint`,2),P([I({attribute:`with-count`,type:Boolean,reflect:!0})],q.prototype,`withCount`,2),P([B(`rows`,{waitUntilFirstUpdate:!0})],q.prototype,`handleRowsChange`,1),P([B(`value`,{waitUntilFirstUpdate:!0})],q.prototype,`handleValueChange`,1),q=P([F(`wa-textarea`)],q),q.disableWarning?.(`change-in-update`);var kr=w`
  :host {
    --checked-icon-color: var(--wa-color-brand-on-loud);
    --checked-icon-scale: 0.8;

    display: inline-flex;
    color: var(--wa-form-control-value-color);
    font-family: inherit;
    font-weight: var(--wa-form-control-value-font-weight);
    line-height: var(--wa-form-control-value-line-height);
    user-select: none;
    -webkit-user-select: none;
  }

  [part~='control'] {
    display: inline-flex;
    flex: 0 0 auto;
    position: relative;
    align-items: center;
    justify-content: center;
    width: var(--wa-form-control-toggle-size);
    height: var(--wa-form-control-toggle-size);
    border-color: var(--wa-form-control-border-color);
    border-radius: min(
      calc(var(--wa-form-control-toggle-size) * 0.375),
      var(--wa-border-radius-s)
    ); /* min prevents entirely circular checkbox */
    border-style: var(--wa-border-style);
    border-width: var(--wa-form-control-border-width);
    background-color: var(--wa-form-control-background-color);
    transition:
      background var(--wa-transition-normal),
      border-color var(--wa-transition-fast),
      box-shadow var(--wa-transition-fast),
      color var(--wa-transition-fast);
    transition-timing-function: var(--wa-transition-easing);

    margin-inline-end: 0.5em;
  }

  [part~='base'] {
    display: flex;
    align-items: flex-start;
    position: relative;
    color: currentColor;
    vertical-align: middle;
    cursor: pointer;
  }

  [part~='label'] {
    display: inline;
  }

  /* Checked */
  [part~='control']:has(:checked, :indeterminate) {
    color: var(--checked-icon-color);
    border-color: var(--wa-form-control-activated-color);
    background-color: var(--wa-form-control-activated-color);
  }

  /* Focus */
  [part~='control']:has(> input:focus-visible:not(:disabled)) {
    outline: var(--wa-focus-ring);
    outline-offset: var(--wa-focus-ring-offset);
  }

  /* Disabled */
  :host [part~='base']:has(input:disabled) {
    opacity: 0.5;
    cursor: not-allowed;
  }

  input {
    position: absolute;
    padding: 0;
    margin: 0;
    height: 100%;
    width: 100%;
    opacity: 0;
    pointer-events: none;
  }

  [part~='icon'] {
    display: flex;
    scale: var(--checked-icon-scale);

    /* Without this, Safari renders the icon slightly to the left */
    &::part(svg) {
      translate: 0.0009765625em;
    }

    input:not(:checked, :indeterminate) + & {
      visibility: hidden;
    }
  }

  :host([required]) [part~='label']::after {
    content: var(--wa-form-control-required-content);
    color: var(--wa-form-control-required-content-color);
    margin-inline-start: var(--wa-form-control-required-content-offset);
  }
`,Ar=(e={})=>{let{validationElement:t,validationProperty:n}=e;t||typeof document<`u`&&`createElement`in document&&(t=Object.assign(document.createElement(`input`),{required:!0})),n||=`value`;let r={observedAttributes:[`required`],message:t?.validationMessage,checkValidity(e){let t={message:``,isValid:!0,invalidKeys:[]};return(e.required??e.hasAttribute(`required`))&&(e[n]||(t.message=typeof r.message==`function`?r.message(e):r.message||``,t.isValid=!1,t.invalidKeys.push(`valueMissing`))),t}};return r},J=class extends H{constructor(){super(...arguments),this.hasSlotController=new nr(this,`hint`),this.title=``,this._value=this.getAttribute(`value`)??null,this.size=`m`,this.disabled=!1,this.indeterminate=!1,this._checked=null,this.defaultChecked=this.hasAttribute(`checked`),this.required=!1,this.hint=``}static get validators(){let e=[Ar({validationProperty:`checked`,validationElement:Object.assign(document.createElement(`input`),{type:`checkbox`,required:!0})})];return[...super.validators,...e]}get value(){return this._value??`on`}set value(e){this._value=e}handleSizeChange(){ar(this.localName,this.size)}get checked(){return this.valueHasChanged?!!this._checked:this._checked??this.defaultChecked}set checked(e){this._checked=!!e,this.valueHasChanged=!0}handleClick(){this.hasInteracted=!0,this.checked=!this.checked,this.indeterminate=!1,this.updateComplete.then(()=>{this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))})}connectedCallback(){if(super.connectedCallback(),this.didSSR&&!this.hasUpdated){this.updateComplete.then(()=>{this.handleDefaultCheckedChange()});return}this.handleDefaultCheckedChange()}handleDefaultCheckedChange(){this.handleValueOrCheckedChange()}handleValueOrCheckedChange(){if(this.didSSR&&!this.hasUpdated){this.updateComplete.then(()=>{this.handleValueOrCheckedChange()});return}this.setValue(this.checked?this.value:null,this._value),this.updateValidity()}handleStateChange(){this.hasUpdated&&(this.input.checked=this.checked,this.input.indeterminate=this.indeterminate),this.customStates.set(`checked`,this.checked),this.customStates.set(`indeterminate`,this.indeterminate),this.updateValidity()}handleDisabledChange(){this.customStates.set(`disabled`,this.disabled)}willUpdate(e){super.willUpdate(e),(e.has(`value`)||e.has(`checked`)||e.has(`defaultChecked`)||e.has(`disabled`))&&this.handleValueOrCheckedChange()}formResetCallback(){this._checked=null,super.formResetCallback(),this.handleValueOrCheckedChange()}click(){this.input.click()}focus(e){this.input.focus(e)}blur(){this.input.blur()}render(){let e=this.hasSlotController.test(`hint`),t=this.hint?!0:!!e,n=!this.checked&&this.indeterminate,r=n?`indeterminate`:`check`,i=n?`indeterminate`:`checked`,a=this.didSSR&&!this.hasUpdated?this.checked:this.defaultChecked,o=this.didSSR&&!this.hasUpdated?null:Sr(this.checked);return j`
      <label part="base checkbox">
        <span part="control">
          <input
            class="input"
            type="checkbox"
            title=${this.title}
            name=${W(this.name)}
            value=${W(this.value)}
            .indeterminate=${Sr(this.indeterminate)}
            .checked=${W(o)}
            ?checked=${a}
            ?disabled=${this.disabled}
            ?required=${this.required}
            aria-checked=${this.indeterminate?`mixed`:this.checked?`true`:`false`}
            aria-describedby="hint"
            @click=${this.handleClick}
          />

          <wa-icon part="${i}-icon icon" library="system" name=${r}></wa-icon>
        </span>

        <slot part="label"></slot>
      </label>

      <slot
        id="hint"
        part="hint"
        name="hint"
        aria-hidden=${t?`false`:`true`}
        class="${U({"has-slotted":t})}"
      >
        ${this.hint}
      </slot>
    `}};J.css=[Qn,or,kr],J.shadowRootOptions={...H.shadowRootOptions,delegatesFocus:!0},P([R(`input[type="checkbox"]`)],J.prototype,`input`,2),P([I()],J.prototype,`title`,2),P([I({reflect:!0})],J.prototype,`value`,1),P([I({reflect:!0})],J.prototype,`size`,2),P([B(`size`)],J.prototype,`handleSizeChange`,1),P([I({type:Boolean})],J.prototype,`disabled`,2),P([I({type:Boolean,reflect:!0})],J.prototype,`indeterminate`,2),P([I({type:Boolean,attribute:!1})],J.prototype,`checked`,1),P([I({type:Boolean,reflect:!0,attribute:`checked`})],J.prototype,`defaultChecked`,2),P([I({type:Boolean,reflect:!0})],J.prototype,`required`,2),P([I()],J.prototype,`hint`,2),P([B([`checked`,`defaultChecked`])],J.prototype,`handleDefaultCheckedChange`,1),P([B([`checked`,`indeterminate`])],J.prototype,`handleStateChange`,1),P([B(`disabled`)],J.prototype,`handleDisabledChange`,1),J=P([F(`wa-checkbox`)],J),J.disableWarning?.(`change-in-update`);var jr=w`
  :host {
    display: flex;
    position: relative;
    align-items: stretch;
    border-radius: var(--wa-panel-border-radius);
    background-color: var(--wa-color-fill-quiet, var(--wa-color-brand-fill-quiet));
    border-color: var(--wa-color-border-quiet, var(--wa-color-brand-border-quiet));
    border-style: var(--wa-panel-border-style);
    border-width: var(--wa-panel-border-width);
    color: var(--wa-color-text-normal);
    padding: 1em;
  }

  /* Appearance modifiers */
  :host([appearance~='plain']) {
    background-color: transparent;
    border-color: transparent;
  }

  :host([appearance~='outlined']) {
    background-color: transparent;
    border-color: var(--wa-color-border-loud, var(--wa-color-brand-border-loud));
  }

  :host([appearance~='filled']) {
    background-color: var(--wa-color-fill-quiet, var(--wa-color-brand-fill-quiet));
    border-color: transparent;
  }

  :host([appearance~='filled-outlined']) {
    border-color: var(--wa-color-border-quiet, var(--wa-color-brand-border-quiet));
  }

  :host([appearance~='accent']) {
    color: var(--wa-color-on-loud, var(--wa-color-brand-on-loud));
    background-color: var(--wa-color-fill-loud, var(--wa-color-brand-fill-loud));
    border-color: transparent;

    [part~='icon'] {
      color: currentColor;
    }
  }

  [part~='icon'] {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    color: var(--wa-color-on-quiet);
    font-size: 1.25em;
  }

  ::slotted([slot='icon']) {
    margin-inline-end: var(--wa-form-control-padding-inline);
  }

  [part~='message'] {
    flex: 1 1 auto;
    display: block;
    overflow: hidden;
  }
`,Mr=class extends z{constructor(){super(...arguments),this.variant=`brand`,this.size=`m`}handleSizeChange(){ar(this.localName,this.size)}render(){return j`
      <div part="icon">
        <slot name="icon"></slot>
      </div>

      <div part="message">
        <slot></slot>
      </div>
    `}};Mr.css=[jr,Pt,or],P([I({reflect:!0})],Mr.prototype,`variant`,2),P([I({reflect:!0})],Mr.prototype,`appearance`,2),P([I({reflect:!0})],Mr.prototype,`size`,2),P([B(`size`)],Mr.prototype,`handleSizeChange`,1),Mr=P([F(`wa-callout`)],Mr);var Nr=w`
  :host {
    --track-width: 2px;
    --track-color: var(--wa-color-neutral-fill-normal);
    --indicator-color: var(--wa-color-brand-fill-loud);
    --speed: 2s;
    --size: 1em;

    /*
      Resizing a spinner element using anything but font-size will break the animation because the animation uses em
      units. Therefore, if a spinner is used in a flex container without \`flex: none\` applied, the spinner can
      grow/shrink and break the animation. The use of \`flex: none\` on the host element prevents this by always having
      the spinner sized according to its actual dimensions.
    */
    flex: none;
    display: inline-flex;
    width: var(--size);
    height: var(--size);
  }

  svg {
    width: 100%;
    height: 100%;
    aspect-ratio: 1;
    animation: spin var(--speed) linear infinite;
  }

  .track,
  .indicator {
    --radius: calc(var(--size) / 2 - var(--track-width) / 2);
    --circumference: calc(var(--radius) * 2 * 3.141592654);

    cx: calc(var(--size) / 2);
    cy: calc(var(--size) / 2);
    r: var(--radius);
    fill: none;
    stroke-width: var(--track-width);
  }

  .track {
    stroke: var(--track-color);
  }

  .indicator {
    stroke: var(--indicator-color);
    stroke-linecap: round;
    stroke-dasharray: calc(0.597 * var(--circumference)), calc(0.796 * var(--circumference));
    stroke-dashoffset: calc(-0.04 * var(--circumference));
    animation: dash 1.5s ease-in-out infinite;
  }

  @keyframes spin {
    0% {
      transform: rotate(0deg);
    }
    100% {
      transform: rotate(360deg);
    }
  }

  @keyframes dash {
    0% {
      stroke-dasharray: calc(0.008 * var(--circumference)), calc(1.194 * var(--circumference));
      stroke-dashoffset: 0;
    }
    50% {
      stroke-dasharray: calc(0.716 * var(--circumference)), calc(1.194 * var(--circumference));
      stroke-dashoffset: calc(-0.278 * var(--circumference));
    }
    100% {
      stroke-dasharray: calc(0.716 * var(--circumference)), calc(1.194 * var(--circumference));
      stroke-dashoffset: calc(-0.987 * var(--circumference));
    }
  }
`,Pr=class extends z{constructor(){super(...arguments),this.localize=new vr(this)}render(){return j`
      <svg
        part="base spinner"
        role="progressbar"
        aria-label=${this.localize.term(`loading`)}
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle class="track" />
        <circle class="indicator" />
      </svg>
    `}};Pr.css=Nr,Pr=P([F(`wa-spinner`)],Pr);var Fr=w`
  :host {
    --tag-max-size: 10ch;
    --show-duration: var(--wa-transition-fast);
    --hide-duration: var(--wa-transition-fast);
  }

  /* Add ellipses to multi select options */
  :host wa-tag::part(content) {
    display: initial;
    white-space: nowrap;
    text-overflow: ellipsis;
    overflow: hidden;
    max-width: var(--tag-max-size);
  }

  :host .disabled [part~='combobox'] {
    opacity: 0.5;
    cursor: not-allowed;
    outline: none;
  }

  :host .enabled:is(.open, :focus-within) [part~='combobox'] {
    outline-color: var(--wa-color-focus);
  }

  /** The popup */
  .select {
    flex: 1 1 auto;
    display: inline-flex;
    width: 100%;
    position: relative;
    vertical-align: middle;

    /* Pass through from select to the popup */
    --show-duration: inherit;
    --hide-duration: inherit;

    &::part(popup) {
      z-index: 900;
    }

    &[data-current-placement^='top']::part(popup) {
      transform-origin: bottom;
    }

    &[data-current-placement^='bottom']::part(popup) {
      transform-origin: top;
    }
  }

  /* Combobox */
  .combobox {
    flex: 1;
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    justify-content: start;

    min-height: var(--wa-form-control-height);

    background-color: var(--wa-form-control-background-color);
    border-color: var(--wa-form-control-border-color);
    border-radius: var(--wa-form-control-border-radius);
    border-style: var(--wa-form-control-border-style);
    border-width: var(--wa-form-control-border-width);
    color: var(--wa-form-control-value-color);
    cursor: pointer;
    font-family: inherit;
    font-weight: var(--wa-form-control-value-font-weight);
    line-height: var(--wa-form-control-value-line-height);
    overflow: hidden;
    padding: 0 var(--wa-form-control-padding-inline);
    position: relative;
    vertical-align: middle;
    transition:
      background-color var(--wa-transition-normal),
      border-color var(--wa-transition-normal),
      outline-color var(--wa-transition-fast);
    transition-timing-function: var(--wa-transition-easing);
    outline: var(--wa-focus-ring-style) var(--wa-focus-ring-width) transparent;
    outline-offset: var(--wa-focus-ring-offset);

    /* Pills */
    :host([pill]) & {
      border-radius: var(--wa-border-radius-pill);
    }
  }

  /* Appearance modifiers */
  :host([appearance='outlined']) .combobox {
    background-color: var(--wa-form-control-background-color);
    border-color: var(--wa-form-control-border-color);
  }

  :host([appearance='filled']) .combobox {
    background-color: var(--wa-color-neutral-fill-quiet);
    border-color: var(--wa-color-neutral-fill-quiet);
  }

  :host([appearance='filled-outlined']) .combobox {
    background-color: var(--wa-color-neutral-fill-quiet);
    border-color: var(--wa-form-control-border-color);
  }

  .display-input {
    position: relative;
    width: 100%;
    font: inherit;
    border: none;
    background: none;
    line-height: var(--wa-form-control-value-line-height);
    color: var(--wa-form-control-value-color);
    cursor: inherit;
    overflow: hidden;
    padding: 0;
    margin: 0;
    -webkit-appearance: none;

    &:focus {
      outline: none;
    }

    &::placeholder {
      color: var(--wa-form-control-placeholder-color);
    }
  }

  /* Manage spacing when tags are present */
  :host([multiple]) {
    --_padding-with-tags: calc(var(--wa-form-control-height) * 0.1 - var(--wa-form-control-border-width));

    & .combobox:has(.tags wa-tag) {
      padding-block: var(--_padding-with-tags);
      padding-inline-start: var(--_padding-with-tags);
    }
  }

  /* Visually hide the display input when multiple is enabled */
  :host([multiple]) .combobox:has(.tags wa-tag) .display-input {
    position: absolute;
    z-index: -1;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
  }

  .value-input {
    position: absolute;
    z-index: -1;
    top: 0;
    left: 0;
    width: 100%;
    height: 100%;
    opacity: 0;
    padding: 0;
    margin: 0;
  }

  .tags {
    display: flex;
    flex: 1;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.25em;

    &::slotted(wa-tag) {
      cursor: pointer !important;
    }

    .disabled &,
    .disabled &::slotted(wa-tag) {
      cursor: not-allowed !important;
    }
  }

  /* Start and End */

  .start,
  .end {
    flex: 0;
    display: inline-flex;
    align-items: center;
    color: var(--wa-color-neutral-on-quiet);
  }

  .end::slotted(*) {
    margin-inline-start: var(--wa-form-control-padding-inline);
  }

  .start::slotted(*) {
    margin-inline-end: var(--wa-form-control-padding-inline);
  }

  :host([multiple]) .combobox:has(.tags wa-tag) .start::slotted(*) {
    margin-inline-start: calc(var(--wa-form-control-padding-inline) - var(--_padding-with-tags));
  }

  /* Clear button */
  [part~='clear-button'] {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    font-size: inherit;
    color: var(--wa-color-neutral-on-quiet);
    border: none;
    background: none;
    padding: 0;
    transition: color var(--wa-transition-normal);
    cursor: pointer;
    margin-inline-start: var(--wa-form-control-padding-inline);

    &:focus {
      outline: none;
    }

    @media (hover: hover) {
      &:hover {
        color: color-mix(in oklab, currentColor, var(--wa-color-mix-hover));
      }
    }

    &:active {
      color: color-mix(in oklab, currentColor, var(--wa-color-mix-active));
    }
  }

  /* Expand icon */
  .expand-icon {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    color: var(--wa-color-neutral-on-quiet);
    transition: rotate var(--wa-transition-slow) var(--wa-transition-easing);
    rotate: 0deg;
    margin-inline-start: var(--wa-form-control-padding-inline);

    .open & {
      rotate: -180deg;
    }
  }

  /* Listbox */
  .listbox {
    display: block;
    position: relative;
    font: inherit;
    box-shadow: var(--wa-shadow-m);
    background: var(--wa-color-surface-raised);
    border-color: var(--wa-color-surface-border);
    border-radius: var(--wa-border-radius-m);
    border-style: var(--wa-border-style);
    border-width: var(--wa-border-width-s);
    padding: 0.25em;
    overflow: auto;
    overscroll-behavior: none;

    /* Make sure it adheres to the popup's auto size */
    max-width: var(--auto-size-available-width);
    max-height: var(--auto-size-available-height);

    &::slotted(wa-divider) {
      --spacing: 0.5em;
    }
  }

  /* Space options with half the listbox's padding */
  .listbox slot:not([name]) {
    display: flex;
    flex-direction: column;
    gap: 0.125em;
  }

  slot:not([name])::slotted(small) {
    display: block;
    font-size: var(--wa-font-size-smaller);
    font-weight: var(--wa-font-weight-semibold);
    color: var(--wa-color-text-quiet);
    padding-block: 0.5em;
    padding-inline: 2.25em;
  }
`,Ir=class extends Event{constructor(){super(`wa-show`,{bubbles:!0,cancelable:!0,composed:!0})}},Lr=class extends Event{constructor(e){super(`wa-hide`,{bubbles:!0,cancelable:!0,composed:!0}),this.detail=e}},Rr=class extends Event{constructor(){super(`wa-after-show`,{bubbles:!0,cancelable:!1,composed:!0})}},zr=class extends Event{constructor(){super(`wa-after-hide`,{bubbles:!0,cancelable:!1,composed:!0})}},Br=[];function Vr(e){Br.push(e)}function Hr(e){for(let t=Br.length-1;t>=0;t--)if(Br[t]===e){Br.splice(t,1);break}}function Ur(e){return Br.length>0&&Br[Br.length-1]===e}function Wr(e,t){return new Promise(n=>{function r(i){i.target===e&&(e.removeEventListener(t,r),n())}e.addEventListener(t,r)})}function Gr(e,t){return new Promise(n=>{let r=new AbortController,{signal:i}=r;if(e.classList.contains(t))return;e.classList.add(t);let a=!1,o=()=>{a||(a=!0,e.classList.remove(t),n(),r.abort())};e.addEventListener(`animationend`,o,{once:!0,signal:i}),e.addEventListener(`animationcancel`,o,{once:!0,signal:i}),requestAnimationFrame(()=>{!a&&e.getAnimations().length===0&&o()})})}var Kr=1,qr=class extends xr{constructor(e){if(super(e),this._value=N,e.type!==yr.CHILD)throw Error(`${this.constructor.directiveName}() can only be used in child bindings`)}render(e){if(e===N||e==null)return this._templateResult=void 0,this._value=e;if(e===M)return e;if(typeof e!=`string`)throw Error(`${this.constructor.directiveName}() called with a non-string value`);if(e===this._value)return this._templateResult;this._value=e;let t=[e];return t.raw=t,this._templateResult={_$litType$:this.constructor.resultType,strings:t,values:[]}}};qr.directiveName=`unsafeHTML`,qr.resultType=Kr;var Jr=br(qr),Y=class extends H{constructor(){super(...arguments),this.assumeInteractionOn=[`blur`,`input`],this.cachedOptions=null,this.hasSlotController=new nr(this,`hint`,`label`),this.localize=new vr(this),this.selectionOrder=new Map,this.typeToSelectString=``,this.slotChangePending=!1,this.displayLabel=``,this.selectedOptions=[],this.name=``,this._defaultValue=null,this.size=`m`,this.placeholder=``,this.multiple=!1,this.maxOptionsVisible=3,this.disabled=!1,this.withClear=!1,this.open=!1,this.appearance=`outlined`,this.pill=!1,this.label=``,this.placement=`bottom`,this.hint=``,this.withLabel=!1,this.withHint=!1,this.required=!1,this.getTag=e=>j`
        <wa-tag
          part="tag"
          exportparts="
            base:tag__base,
            content:tag__content,
            remove-button:tag__remove-button,
            remove-button__base:tag__remove-button__base
          "
          ?pill=${this.pill}
          size=${this.size}
          with-remove
          data-value=${e.value}
          @wa-remove=${t=>this.handleTagRemove(t,e)}
        >
          ${e.label}
        </wa-tag>
      `,this.handleDocumentFocusIn=e=>{let t=e.composedPath();this&&!t.includes(this)&&this.hide()},this.handleDocumentKeyDown=e=>{let t=e.target,n=t.closest(`[part~="clear-button"]`)!==null,r=t.closest(`wa-button`)!==null;if(!(n||r)){if(e.key===`Escape`&&this.open&&Ur(this)&&(e.preventDefault(),e.stopPropagation(),this.hide(),this.displayInput.focus({preventScroll:!0})),e.key===`Enter`||e.key===` `&&this.typeToSelectString===``){if(e.preventDefault(),e.stopImmediatePropagation(),!this.open){this.show();return}this.currentOption&&!this.currentOption.disabled&&(this.valueHasChanged=!0,this.hasInteracted=!0,this.multiple?this.toggleOptionSelection(this.currentOption):this.setSelectedOptions(this.currentOption),this.updateComplete.then(()=>{this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0})),this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))}),this.multiple||(this.hide(),this.displayInput.focus({preventScroll:!0})));return}if([`ArrowUp`,`ArrowDown`,`Home`,`End`].includes(e.key)){let t=this.getAllOptions(),n=t.indexOf(this.currentOption),r=Math.max(0,n);if(e.preventDefault(),!this.open&&(this.show(),this.currentOption))return;e.key===`ArrowDown`?(r=n+1,r>t.length-1&&(r=0)):e.key===`ArrowUp`?(r=n-1,r<0&&(r=t.length-1)):e.key===`Home`?r=0:e.key===`End`&&(r=t.length-1),this.setCurrentOption(t[r])}if(e.key?.length===1||e.key===`Backspace`){let t=this.getAllOptions();if(e.metaKey||e.ctrlKey||e.altKey)return;if(!this.open){if(e.key===`Backspace`)return;this.show()}e.stopPropagation(),e.preventDefault(),clearTimeout(this.typeToSelectTimeout),this.typeToSelectTimeout=window.setTimeout(()=>this.typeToSelectString=``,1e3),e.key===`Backspace`?this.typeToSelectString=this.typeToSelectString.slice(0,-1):this.typeToSelectString+=e.key.toLowerCase();for(let e of t)if(e.label.toLowerCase().startsWith(this.typeToSelectString)){this.setCurrentOption(e);break}}}},this.handleDocumentMouseDown=e=>{let t=e.composedPath();this&&!t.includes(this)&&this.hide()}}static get validators(){let e=[Ar({validationElement:Object.assign(document.createElement(`select`),{required:!0})})];return[...super.validators,...e]}get validationTarget(){return this.valueInput}set defaultValue(e){this._defaultValue=this.convertDefaultValue(e)}get defaultValue(){return this.convertDefaultValue(this._defaultValue)}rawValuesEqual(e,t){return e==null&&t==null?!0:e==null||t==null||e.length!==t.length?!1:e.every((e,n)=>e===t[n])}convertDefaultValue(e){return!(this.multiple||this.hasAttribute(`multiple`))&&Array.isArray(e)&&(e=e[0]),e}set value(e){let t=this.value;e instanceof FormData&&(e=e.getAll(this.name)),e!=null&&!Array.isArray(e)&&(e=[e]);let n=this._value;this._value=e??null,this.rawValuesEqual(n,this._value)||(this.valueHasChanged=!0,this.requestUpdate(`value`,t))}get value(){let e=this._value??this.defaultValue??null;e!=null&&(e=Array.isArray(e)?e:[e]),this.optionValues=new Set(this.getAllOptions().filter(e=>!e.disabled).map(e=>e.value));let t=e;return e!=null&&(t=e.filter(e=>this.optionValues.has(e)),t=this.multiple?t:t[0],t??=null),t}handleSizeChange(){ar(this.localName,this.size)}connectedCallback(){super.connectedCallback(),this.processSlotChange(),this.open=!1}disconnectedCallback(){super.disconnectedCallback(),this.removeOpenListeners(),this.cachedOptions=null}updateDefaultValue(){let e=this.getAllOptions().filter(e=>e.hasAttribute(`selected`)||e.defaultSelected);if(e.length>0){let t=e.map(e=>e.value);this._defaultValue=this.multiple?t:t[0]}this.hasAttribute(`value`)&&(this._defaultValue=this.getAttribute(`value`)||null)}addOpenListeners(){document.addEventListener(`focusin`,this.handleDocumentFocusIn),document.addEventListener(`keydown`,this.handleDocumentKeyDown),document.addEventListener(`mousedown`,this.handleDocumentMouseDown),Vr(this),this.getRootNode()!==document&&this.getRootNode().addEventListener(`focusin`,this.handleDocumentFocusIn)}removeOpenListeners(){document.removeEventListener(`focusin`,this.handleDocumentFocusIn),document.removeEventListener(`keydown`,this.handleDocumentKeyDown),document.removeEventListener(`mousedown`,this.handleDocumentMouseDown),Hr(this),this.getRootNode()!==document&&this.getRootNode().removeEventListener(`focusin`,this.handleDocumentFocusIn)}handleFocus(){this.displayInput.setSelectionRange(0,0)}handleLabelClick(){this.displayInput.focus()}handleComboboxClick(e){e.preventDefault()}handleComboboxMouseDown(e){let t=e.composedPath().some(e=>e instanceof Element&&e.tagName.toLowerCase()===`wa-button`);this.disabled||t||(e.preventDefault(),this.displayInput.focus({preventScroll:!0}),this.open=!this.open)}handleComboboxKeyDown(e){e.stopPropagation(),this.handleDocumentKeyDown(e)}handleClearClick(e){e.stopPropagation(),this.hasInteracted=!0,this.valueHasChanged=!0,this.value!==null&&(this.displayLabel=``,this.selectionOrder.clear(),this.setSelectedOptions([]),this.displayInput.focus({preventScroll:!0}),this.updateComplete.then(()=>{this.dispatchEvent(new Jn),this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0})),this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))}))}handleClearMouseDown(e){e.stopPropagation(),e.preventDefault()}handleOptionClick(e){let t=e.target.closest(`wa-option`);t&&!t.disabled&&(this.hasInteracted=!0,this.valueHasChanged=!0,this.multiple?this.toggleOptionSelection(t):this.setSelectedOptions(t),this.updateComplete.then(()=>this.displayInput.focus({preventScroll:!0})),this.requestUpdate(`value`),this.updateComplete.then(()=>{this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0})),this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))}),this.multiple||(this.hide(),this.displayInput.focus({preventScroll:!0})))}handleDefaultSlotChange(){this.slotChangePending||(this.slotChangePending=!0,queueMicrotask(()=>{this.slotChangePending=!1,this.processSlotChange()}))}processSlotChange(){if(customElements.get(`wa-option`)||customElements.whenDefined(`wa-option`).then(()=>this.handleDefaultSlotChange()),this.didSSR&&!this.hasUpdated){this.updateComplete.then(()=>{this.handleDefaultSlotChange()});return}this.cachedOptions=null;let e=this.getAllOptions();this.updateDefaultValue();let t=this.value;if(t==null||!this.valueHasChanged&&!this.hasInteracted){this.selectionChanged();return}Array.isArray(t)||(t=[t]);let n=e.filter(e=>t.includes(e.value));this.setSelectedOptions(n)}handleTagRemove(e,t){if(e.stopPropagation(),this.disabled)return;this.hasInteracted=!0,this.valueHasChanged=!0;let n=t;if(!n){let t=e.target.closest(`wa-tag[data-value]`);if(t){let e=t.dataset.value;n=this.selectedOptions.find(t=>t.value===e)}}n&&(this.toggleOptionSelection(n,!1),this.updateComplete.then(()=>{this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0})),this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))}))}getAllOptions(){return this.cachedOptions?this.cachedOptions:this?.querySelectorAll?(this.cachedOptions=[...this.querySelectorAll(`wa-option`)],this.cachedOptions):[]}getFirstOption(){return this.querySelector(`wa-option`)}setCurrentOption(e){this.getAllOptions().forEach(e=>{e.current=!1,e.tabIndex=-1}),e&&(this.currentOption=e,e.current=!0,e.tabIndex=0,e.focus({preventScroll:!0}),this.open&&!this.listbox.hidden&&Er(e,this.listbox,`vertical`,`auto`))}setSelectedOptions(e){let t=this.getAllOptions(),n=Array.isArray(e)?e:[e];t.forEach(e=>{n.includes(e)||(e.selected=!1)}),n.length&&n.forEach(e=>e.selected=!0),this.selectionChanged()}toggleOptionSelection(e,t){e.selected=t===!0||t===!1?t:!e.selected,this.selectionChanged()}selectionChanged(){let e=this.getAllOptions().filter(e=>{if(!this.hasInteracted&&!this.valueHasChanged){let t=this.defaultValue,n=Array.isArray(t)?t:[t];return e.hasAttribute(`selected`)||e.defaultSelected||e.selected||n?.includes(e.value)}return e.selected}),t=new Set(e.map(e=>e.value));for(let e of this.selectionOrder.keys())t.has(e)||this.selectionOrder.delete(e);let n=(this.selectionOrder.size>0?Math.max(...this.selectionOrder.values()):-1)+1;for(let t of e)this.selectionOrder.has(t.value)||this.selectionOrder.set(t.value,n++);this.selectedOptions=e.sort((e,t)=>(this.selectionOrder.get(e.value)??0)-(this.selectionOrder.get(t.value)??0));let r=new Set(this.selectedOptions.map(e=>e.value));if(r.size>0||this._value){let e=this._value;if(this._value==null){let e=this.defaultValue??[];this._value=Array.isArray(e)?e:[e]}this._value=this._value?.filter(e=>!this.optionValues?.has(e))??null,this._value?.unshift(...r),this.requestUpdate(`value`,e)}if(this.multiple)this.displayLabel=this.placeholder&&!this.value?.length?``:this.localize.term(`numOptionsSelected`,this.selectedOptions.length);else{let e=this.selectedOptions[0];this.displayLabel=e?.label??``}this.updateComplete.then(()=>{this.updateValidity()})}get tags(){return this.selectedOptions.map((e,t)=>{if(t<this.maxOptionsVisible||this.maxOptionsVisible<=0){let n=this.getTag(e,t);return n?typeof n==`string`?Jr(n):n:null}return t===this.maxOptionsVisible?j`
          <wa-tag
            part="tag"
            exportparts="
              base:tag__base,
              content:tag__content,
              remove-button:tag__remove-button,
              remove-button__base:tag__remove-button__base
            "
            >+${this.selectedOptions.length-t}</wa-tag
          >
        `:null})}updated(e){super.updated(e),(e.has(`value`)||e.has(`displayLabel`))&&this.customStates.set(`blank`,!this.value&&!this.displayLabel)}handleDisabledChange(){this.disabled&&this.open&&(this.open=!1)}handleValueChange(){let e=this.getAllOptions(),t=Array.isArray(this.value)?this.value:[this.value],n=e.filter(e=>t.includes(e.value));this.setSelectedOptions(n),this.updateValidity()}async handleOpenChange(){if(this.open&&!this.disabled){this.setCurrentOption(this.selectedOptions[0]||this.getFirstOption());let e=new Ir;if(this.dispatchEvent(e),e.defaultPrevented){this.open=!1;return}this.addOpenListeners(),this.listbox.hidden=!1,this.popup.active=!0,requestAnimationFrame(()=>{this.setCurrentOption(this.currentOption)}),await Gr(this.popup.popup,`show`),this.currentOption&&Er(this.currentOption,this.listbox,`vertical`,`auto`),this.dispatchEvent(new Rr)}else{let e=new Lr;if(this.dispatchEvent(e),e.defaultPrevented){this.open=!1;return}this.removeOpenListeners(),await Gr(this.popup.popup,`hide`),this.listbox.hidden=!0,this.popup.active=!1,this.dispatchEvent(new zr)}}async show(){if(this.open||this.disabled){this.open=!1;return}return this.open=!0,Wr(this,`wa-after-show`)}async hide(){if(!this.open||this.disabled){this.open=!1;return}return this.open=!1,Wr(this,`wa-after-hide`)}focus(e){this.displayInput.focus(e)}blur(){this.displayInput.blur()}formResetCallback(){this.selectionOrder.clear(),this.value=this.defaultValue,super.formResetCallback(),this.handleValueChange(),this.updateComplete.then(()=>{this.dispatchEvent(new InputEvent(`input`,{bubbles:!0,composed:!0})),this.dispatchEvent(new Event(`change`,{bubbles:!0,composed:!0}))})}render(){let e=this.hasSlotController.test(`label`,`withLabel`),t=this.hasSlotController.test(`hint`,`withHint`),n=this.label?!0:!!e,r=this.hint?!0:!!t,i=(this.hasUpdated||!1)&&this.withClear&&!this.disabled&&(this.displayLabel||this.value&&this.value.length>0);return j`
      <div
        part="form-control"
        class=${U({"form-control":!0,"form-control-has-label":n})}
      >
        <label
          id="label"
          part="form-control-label label"
          class=${U({label:!0,"has-label":n})}
          aria-hidden=${n?`false`:`true`}
          @click=${this.handleLabelClick}
        >
          <slot name="label">${this.label}</slot>
        </label>

        <div part="form-control-input" class="form-control-input">
          <wa-popup
            class=${U({select:!0,open:this.open,disabled:this.disabled,enabled:!this.disabled,multiple:this.multiple})}
            placement=${this.placement}
            flip
            shift
            sync="width"
            auto-size="vertical"
            auto-size-padding="10"
          >
            <div
              part="combobox"
              class="combobox"
              slot="anchor"
              @keydown=${this.handleComboboxKeyDown}
              @mousedown=${this.handleComboboxMouseDown}
              @click=${this.handleComboboxClick}
            >
              <slot part="start" name="start" class="start"></slot>

              <input
                part="display-input"
                class="display-input"
                type="text"
                placeholder=${this.placeholder}
                .disabled=${this.disabled}
                .value=${this.displayLabel}
                ?required=${this.required}
                autocomplete="off"
                spellcheck="false"
                autocapitalize="off"
                readonly
                aria-invalid=${!this.validity.valid}
                aria-controls="listbox"
                aria-expanded=${this.open?`true`:`false`}
                aria-haspopup="listbox"
                aria-labelledby="label"
                aria-disabled=${this.disabled?`true`:`false`}
                aria-describedby="hint"
                role="combobox"
                tabindex="0"
                @focus=${this.handleFocus}
              />

              <!-- Tags need to wait for first hydration before populating otherwise it will create a hydration mismatch. -->
              ${this.multiple&&this.hasUpdated?j`<div part="tags" class="tags" @wa-remove=${this.handleTagRemove}>${this.tags}</div>`:``}

              <input
                class="value-input"
                type="text"
                ?disabled=${this.disabled}
                ?required=${this.required}
                .value=${Array.isArray(this.value)?this.value.join(`, `):this.value}
                tabindex="-1"
                aria-hidden="true"
                @focus=${()=>this.focus()}
              />

              ${i?j`
                    <button
                      part="clear-button"
                      type="button"
                      aria-label=${this.localize.term(`clearEntry`)}
                      @mousedown=${this.handleClearMouseDown}
                      @click=${this.handleClearClick}
                      tabindex="-1"
                    >
                      <slot name="clear-icon">
                        <wa-icon name="circle-xmark" library="system" variant="regular"></wa-icon>
                      </slot>
                    </button>
                  `:``}

              <slot name="end" part="end" class="end"></slot>

              <slot name="expand-icon" part="expand-icon" class="expand-icon">
                <wa-icon library="system" name="chevron-down" variant="solid"></wa-icon>
              </slot>
            </div>

            <div
              id="listbox"
              role="listbox"
              aria-expanded=${this.open?`true`:`false`}
              aria-multiselectable=${this.multiple?`true`:`false`}
              aria-labelledby="label"
              part="listbox"
              class="listbox"
              tabindex="-1"
              @mouseup=${this.handleOptionClick}
            >
              <slot @slotchange=${this.handleDefaultSlotChange}></slot>
            </div>
          </wa-popup>
        </div>

        <slot
          id="hint"
          name="hint"
          part="hint"
          class=${U({"has-slotted":r})}
          aria-hidden=${r?`false`:`true`}
          >${this.hint}</slot
        >
      </div>
    `}};Y.css=[Fr,Qn,or],P([R(`.select`)],Y.prototype,`popup`,2),P([R(`.combobox`)],Y.prototype,`combobox`,2),P([R(`.display-input`)],Y.prototype,`displayInput`,2),P([R(`.value-input`)],Y.prototype,`valueInput`,2),P([R(`.listbox`)],Y.prototype,`listbox`,2),P([L()],Y.prototype,`displayLabel`,2),P([L()],Y.prototype,`currentOption`,2),P([L()],Y.prototype,`selectedOptions`,2),P([I({reflect:!0})],Y.prototype,`name`,2),P([I({attribute:!1})],Y.prototype,`defaultValue`,1),P([I({attribute:`value`,reflect:!1})],Y.prototype,`value`,1),P([I({reflect:!0})],Y.prototype,`size`,2),P([B(`size`)],Y.prototype,`handleSizeChange`,1),P([I()],Y.prototype,`placeholder`,2),P([I({type:Boolean,reflect:!0})],Y.prototype,`multiple`,2),P([I({attribute:`max-options-visible`,type:Number})],Y.prototype,`maxOptionsVisible`,2),P([I({type:Boolean})],Y.prototype,`disabled`,2),P([I({attribute:`with-clear`,type:Boolean})],Y.prototype,`withClear`,2),P([I({type:Boolean,reflect:!0})],Y.prototype,`open`,2),P([I({reflect:!0})],Y.prototype,`appearance`,2),P([I({type:Boolean,reflect:!0})],Y.prototype,`pill`,2),P([I()],Y.prototype,`label`,2),P([I({reflect:!0})],Y.prototype,`placement`,2),P([I({attribute:`hint`})],Y.prototype,`hint`,2),P([I({attribute:`with-label`,type:Boolean})],Y.prototype,`withLabel`,2),P([I({attribute:`with-hint`,type:Boolean})],Y.prototype,`withHint`,2),P([I({type:Boolean,reflect:!0})],Y.prototype,`required`,2),P([I({attribute:!1})],Y.prototype,`getTag`,2),P([B(`disabled`,{waitUntilFirstUpdate:!0})],Y.prototype,`handleDisabledChange`,1),P([B(`value`,{waitUntilFirstUpdate:!0})],Y.prototype,`handleValueChange`,1),P([B(`open`,{waitUntilFirstUpdate:!0})],Y.prototype,`handleOpenChange`,1),Y=P([F(`wa-select`)],Y),Y.disableWarning?.(`change-in-update`);var Yr=class extends Event{constructor(){super(`wa-remove`,{bubbles:!0,cancelable:!1,composed:!0})}},Xr=w`
  @layer wa-component {
    :host {
      display: inline-flex;
      gap: 0.5em;
      border-radius: var(--wa-border-radius-m);
      align-items: center;
      background-color: var(--wa-color-fill-quiet, var(--wa-color-neutral-fill-quiet));
      border-color: var(--wa-color-border-normal, var(--wa-color-neutral-border-normal));
      border-style: var(--wa-border-style);
      border-width: var(--wa-border-width-s);
      color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
      font-size: inherit;
      line-height: 1;
      white-space: nowrap;
      user-select: none;
      -webkit-user-select: none;
      height: calc(var(--wa-form-control-height) * 0.8);
      line-height: calc(var(--wa-form-control-height) - var(--wa-form-control-border-width) * 2);
      padding: 0 0.75em;
    }

    /* Appearance modifiers */
    :host([appearance='outlined']) {
      color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
      background-color: transparent;
      border-color: var(--wa-color-border-loud, var(--wa-color-neutral-border-loud));
    }

    :host([appearance='filled']) {
      color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
      background-color: var(--wa-color-fill-quiet, var(--wa-color-neutral-fill-quiet));
      border-color: transparent;
    }

    :host([appearance='filled-outlined']) {
      color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
      background-color: var(--wa-color-fill-quiet, var(--wa-color-neutral-fill-quiet));
      border-color: var(--wa-color-border-normal, var(--wa-color-neutral-border-normal));
    }

    :host([appearance='accent']) {
      color: var(--wa-color-on-loud, var(--wa-color-neutral-on-loud));
      background-color: var(--wa-color-fill-loud, var(--wa-color-neutral-fill-loud));
      border-color: transparent;
    }
  }

  .content {
    font-size: var(--wa-font-size-smaller);
  }

  [part='remove-button'] {
    line-height: 1;
  }

  [part='remove-button']::part(base) {
    padding: 0;
    height: 1em;
    width: 1em;
    color: currentColor;
  }

  @media (hover: hover) {
    :host(:hover) > [part='remove-button']::part(base) {
      background-color: transparent;
      color: color-mix(in oklab, currentColor, var(--wa-color-mix-hover));
    }
  }

  :host(:active) > [part='remove-button']::part(base) {
    background-color: transparent;
    color: color-mix(in oklab, currentColor, var(--wa-color-mix-active));
  }

  /*
   * Pill modifier
   */
  :host([pill]) {
    border-radius: var(--wa-border-radius-pill);
  }
`,Zr=class extends z{constructor(){super(...arguments),this.localize=new vr(this),this.variant=`neutral`,this.appearance=`filled-outlined`,this.size=`m`,this.pill=!1,this.withRemove=!1}handleSizeChange(){ar(this.localName,this.size)}handleRemoveClick(){this.dispatchEvent(new Yr)}render(){return j`
      <slot part="content" class="content"></slot>

      ${this.withRemove?j`
            <wa-button
              part="remove-button"
              exportparts="base:remove-button__base"
              class="remove"
              appearance="plain"
              size=${this.size}
              @click=${this.handleRemoveClick}
              tabindex="-1"
            >
              <wa-icon name="xmark" library="system" variant="solid" label=${this.localize.term(`remove`)}></wa-icon>
            </wa-button>
          `:``}
    `}};Zr.css=[Xr,Pt,or],P([I({reflect:!0})],Zr.prototype,`variant`,2),P([I({reflect:!0})],Zr.prototype,`appearance`,2),P([I({reflect:!0})],Zr.prototype,`size`,2),P([B(`size`)],Zr.prototype,`handleSizeChange`,1),P([I({type:Boolean,reflect:!0})],Zr.prototype,`pill`,2),P([I({attribute:`with-remove`,type:Boolean})],Zr.prototype,`withRemove`,2),Zr=P([F(`wa-tag`)],Zr);var Qr=w`
  :host {
    --current-text-color: var(--wa-color-brand-on-loud);

    display: block;
    color: var(--wa-color-text-normal);
    -webkit-user-select: none;
    user-select: none;

    position: relative;
    display: flex;
    align-items: center;
    font: inherit;
    padding: 0.5em 1em 0.5em 0.25em;
    border-radius: var(--wa-border-radius-s);
    line-height: var(--wa-line-height-condensed);
    transition: var(--wa-transition-fast) background-color var(--wa-transition-easing);
    cursor: pointer;
  }

  :host(:focus) {
    outline: none;
  }

  @media (hover: hover) {
    :host(:not(:state(disabled), :state(current)):is(:state(hover), :hover)) {
      background-color: var(--wa-color-neutral-fill-normal);
      color: var(--wa-color-neutral-on-normal);
    }
  }

  :host(:state(current)),
  :host(:state(disabled):state(current)) {
    background-color: var(--wa-form-control-activated-color);
    color: var(--current-text-color);
    opacity: 1;
  }

  :host(:state(disabled)) {
    outline: none;
    opacity: 0.5;
    cursor: not-allowed;
  }

  .label {
    flex: 1 1 auto;
    display: inline-block;
  }

  .check {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    font-size: var(--wa-font-size-smaller);
    visibility: hidden;
    width: 2em;
  }

  :host(:state(selected)) .check {
    visibility: visible;
  }

  .start,
  .end {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
  }

  .start::slotted(*) {
    margin-inline-end: 0.5em;
  }

  .end::slotted(*) {
    margin-inline-start: 0.5em;
  }

  @media (forced-colors: active) {
    :host(:hover:not([aria-disabled='true'])) {
      outline: dashed 1px SelectedItem;
      outline-offset: -1px;
    }
  }
`;function $r(e,t=0){if(!e||!globalThis.Node)return``;if(typeof e[Symbol.iterator]==`function`)return(Array.isArray(e)?e:[...e]).map(e=>$r(e,--t)).join(``);let n=e;if(n.nodeType===Node.TEXT_NODE)return n.textContent??``;if(n.nodeType===Node.ELEMENT_NODE){let e=n;if(e.hasAttribute(`slot`)||e.matches(`style, script`))return``;if(e instanceof HTMLSlotElement){let n=e.assignedNodes({flatten:!0});if(n.length>0)return $r(n,--t)}return t>-1?$r(e,--t):e.textContent??``}return n.hasChildNodes()?$r(n.childNodes,--t):``}var ei=class extends z{constructor(){super(...arguments),this.localize=new vr(this),this.cachedDefaultLabel=``,this.isInitialized=!1,this.isDefaultLabelDirty=!0,this.current=!1,this.value=``,this.disabled=!1,this.selected=!1,this.defaultSelected=!1,this._label=``,this.handleHover=e=>{e.type===`mouseenter`?this.customStates.set(`hover`,!0):e.type===`mouseleave`&&this.customStates.set(`hover`,!1)}}set label(e){let t=this._label;this._label=e||``,this._label!==t&&this.requestUpdate(`label`,t)}get label(){return this._label?this._label:this.defaultLabel}get defaultLabel(){return(this.isDefaultLabelDirty||!this.cachedDefaultLabel)&&this.updateDefaultLabel(),this.cachedDefaultLabel}connectedCallback(){super.connectedCallback(),this.setAttribute(`role`,`option`),this.setAttribute(`aria-selected`,`false`),this.addEventListener(`mouseenter`,this.handleHover),this.addEventListener(`mouseleave`,this.handleHover)}disconnectedCallback(){super.disconnectedCallback(),this.removeEventListener(`mouseenter`,this.handleHover),this.removeEventListener(`mouseleave`,this.handleHover)}handleDefaultSlotChange(){this.isDefaultLabelDirty=!0,this.isInitialized?(customElements.whenDefined(`wa-select`).then(()=>{let e=this.closest(`wa-select`);e&&e.handleDefaultSlotChange?.()}),customElements.whenDefined(`wa-combobox`).then(()=>{let e=this.closest(`wa-combobox`);e&&e.handleDefaultSlotChange?.()})):this.isInitialized=!0}willUpdate(e){e.has(`defaultSelected`)&&(this.didSSR&&this.hasUpdated||!this.didSSR)&&this.syncDefaultSelected(),super.willUpdate(e)}syncDefaultSelected(){if(`closest`in this&&!this.closest(`wa-combobox, wa-select`)?.hasInteracted&&this.defaultSelected){let e=this.selected;this.selected=this.defaultSelected,this.requestUpdate(`selected`,e)}}updated(e){e.has(`disabled`)&&(this.setAttribute(`aria-disabled`,this.disabled?`true`:`false`),this.customStates.set(`disabled`,this.disabled)),e.has(`selected`)&&(this.setAttribute(`aria-selected`,this.selected?`true`:`false`),this.customStates.set(`selected`,this.selected)),e.has(`value`)&&(typeof this.value!=`string`&&(this.value=String(this.value)),this.handleDefaultSlotChange()),e.has(`current`)&&this.customStates.set(`current`,this.current),super.updated(e)}async firstUpdated(e){if(super.firstUpdated(e),this.didSSR&&!this.hasUpdated&&await this.updateComplete,this.syncDefaultSelected(),this.selected&&!this.defaultSelected){let e=this.closest(`wa-select, wa-combobox`);e&&!e.hasInteracted&&(await customElements.whenDefined(e?.localName),await e.updateComplete,e.selectionChanged?.())}}updateDefaultLabel(){let e=this.cachedDefaultLabel;this.cachedDefaultLabel=$r(this).trim(),this.isDefaultLabelDirty=!1;let t=this.cachedDefaultLabel!==e;return!this._label&&t&&this.requestUpdate(`label`,e),t}render(){let e=this.selected;return this.didSSR&&!this.hasUpdated?(this.updateComplete.then(()=>{this.requestUpdate()}),N):j`
      ${e?j`<wa-icon
            part="checked-icon"
            class="check"
            name="check"
            library="system"
            variant="solid"
            aria-hidden="true"
          ></wa-icon>`:j`<span part="checked-icon" class="check" aria-hidden="true"></span>`}
      <slot part="start" name="start" class="start"></slot>
      <slot part="label" class="label" @slotchange=${this.handleDefaultSlotChange}></slot>
      <slot part="end" name="end" class="end"></slot>
    `}};ei.css=Qr,P([R(`.label`)],ei.prototype,`defaultSlot`,2),P([L()],ei.prototype,`current`,2),P([I({reflect:!0})],ei.prototype,`value`,2),P([I({type:Boolean})],ei.prototype,`disabled`,2),P([I({type:Boolean,attribute:!1})],ei.prototype,`selected`,2),P([I({type:Boolean,attribute:`selected`})],ei.prototype,`defaultSelected`,2),P([I()],ei.prototype,`label`,1),ei=P([F(`wa-option`)],ei);var ti=class extends Event{constructor(){super(`wa-reposition`,{bubbles:!0,cancelable:!1,composed:!0})}},ni=w`
  :host {
    --arrow-color: black;
    --arrow-size: var(--wa-tooltip-arrow-size);
    --popup-border-width: 0px;
    --show-duration: var(--wa-transition-fast);
    --hide-duration: var(--wa-transition-fast);

    /*
     * These properties are computed to account for the arrow's dimensions after being rotated 45º. The constant
     * 0.7071 is derived from sin(45) to calculate the length of the arrow after rotation.
     *
     * The diamond will be translated inward by --arrow-base-offset, the border thickness, to centralise it on
     * the inner edge of the popup border. This also means we need to increase the size of the arrow by the
     * same amount to compensate.
     *
     * A diamond shaped clipping mask is used to avoid overlap of popup content. This extends slightly inward so
     * the popup border is covered with no sub-pixel rounding artifacts. The diamond corners are mitred at 22.5º
     * to properly merge any arrow border with the popup border. The constant 1.4142 is derived from 1 + tan(22.5).
     *
     */
    --arrow-base-offset: var(--popup-border-width);
    --arrow-size-diagonal: calc((var(--arrow-size) + var(--arrow-base-offset)) * 0.7071);
    --arrow-padding-offset: calc(var(--arrow-size-diagonal) - var(--arrow-size));
    --arrow-size-div: calc(var(--arrow-size-diagonal) * 2);
    --arrow-clipping-corner: calc(var(--arrow-base-offset) * 1.4142);

    display: contents;
  }

  .popup {
    position: absolute;
    isolation: isolate;
    max-width: var(--auto-size-available-width, none);
    max-height: var(--auto-size-available-height, none);

    /* Clear UA styles for [popover] */
    :where(&) {
      inset: unset;
      padding: unset;
      margin: unset;
      width: unset;
      height: unset;
      color: unset;
      background: unset;
      border: unset;
      overflow: unset;
    }
  }

  .popup-fixed {
    position: fixed;
  }

  .popup:not(.popup-active) {
    display: none;
  }

  .arrow {
    position: absolute;
    width: var(--arrow-size-div);
    height: var(--arrow-size-div);
    background: var(--arrow-color);
    z-index: 3;
    clip-path: polygon(
      var(--arrow-clipping-corner) 100%,
      var(--arrow-base-offset) calc(100% - var(--arrow-base-offset)),
      calc(var(--arrow-base-offset) - 2px) calc(100% - var(--arrow-base-offset)),
      calc(100% - var(--arrow-base-offset)) calc(var(--arrow-base-offset) - 2px),
      calc(100% - var(--arrow-base-offset)) var(--arrow-base-offset),
      100% var(--arrow-clipping-corner),
      100% 100%
    );
    rotate: 45deg;
  }

  :host([data-current-placement|='left']) .arrow {
    rotate: -45deg;
  }

  :host([data-current-placement|='right']) .arrow {
    rotate: 135deg;
  }

  :host([data-current-placement|='bottom']) .arrow {
    rotate: 225deg;
  }

  /* Hover bridge */
  .popup-hover-bridge:not(.popup-hover-bridge-visible) {
    display: none;
  }

  .popup-hover-bridge {
    position: fixed;
    z-index: 899;
    top: 0;
    right: 0;
    bottom: 0;
    left: 0;
    clip-path: polygon(
      var(--hover-bridge-top-left-x, 0) var(--hover-bridge-top-left-y, 0),
      var(--hover-bridge-top-right-x, 0) var(--hover-bridge-top-right-y, 0),
      var(--hover-bridge-bottom-right-x, 0) var(--hover-bridge-bottom-right-y, 0),
      var(--hover-bridge-bottom-left-x, 0) var(--hover-bridge-bottom-left-y, 0)
    );
  }

  /* Built-in animations */
  .show {
    animation: show var(--show-duration) ease;
  }

  .hide {
    animation: show var(--hide-duration) ease reverse;
  }

  @keyframes show {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .show-with-scale {
    animation: show-with-scale var(--show-duration) ease;
  }

  .hide-with-scale {
    animation: show-with-scale var(--hide-duration) ease reverse;
  }

  @keyframes show-with-scale {
    from {
      opacity: 0;
      scale: 0.8;
    }
    to {
      opacity: 1;
      scale: 1;
    }
  }
`,ri=Math.min,ii=Math.max,ai=Math.round,oi=Math.floor,si=e=>({x:e,y:e}),ci={left:`right`,right:`left`,bottom:`top`,top:`bottom`};function li(e,t,n){return ii(e,ri(t,n))}function ui(e,t){return typeof e==`function`?e(t):e}function di(e){return e.split(`-`)[0]}function fi(e){return e.split(`-`)[1]}function pi(e){return e===`x`?`y`:`x`}function mi(e){return e===`y`?`height`:`width`}function hi(e){let t=e[0];return t===`t`||t===`b`?`y`:`x`}function gi(e){return pi(hi(e))}function _i(e,t,n){n===void 0&&(n=!1);let r=fi(e),i=gi(e),a=mi(i),o=i===`x`?r===(n?`end`:`start`)?`right`:`left`:r===`start`?`bottom`:`top`;return t.reference[a]>t.floating[a]&&(o=Ei(o)),[o,Ei(o)]}function vi(e){let t=Ei(e);return[yi(e),t,yi(t)]}function yi(e){return e.includes(`start`)?e.replace(`start`,`end`):e.replace(`end`,`start`)}var bi=[`left`,`right`],xi=[`right`,`left`],Si=[`top`,`bottom`],Ci=[`bottom`,`top`];function wi(e,t,n){switch(e){case`top`:case`bottom`:return n?t?xi:bi:t?bi:xi;case`left`:case`right`:return t?Si:Ci;default:return[]}}function Ti(e,t,n,r){let i=fi(e),a=wi(di(e),n===`start`,r);return i&&(a=a.map(e=>e+`-`+i),t&&(a=a.concat(a.map(yi)))),a}function Ei(e){let t=di(e);return ci[t]+e.slice(t.length)}function Di(e){return{top:e.top??0,right:e.right??0,bottom:e.bottom??0,left:e.left??0}}function Oi(e){return typeof e==`number`?{top:e,right:e,bottom:e,left:e}:Di(e)}function ki(e){let{x:t,y:n,width:r,height:i}=e;return{width:r,height:i,top:n,left:t,right:t+r,bottom:n+i,x:t,y:n}}function Ai(e,t,n){let{reference:r,floating:i}=e,a=hi(t),o=gi(t),s=mi(o),c=di(t),l=a===`y`,u=r.x+r.width/2-i.width/2,d=r.y+r.height/2-i.height/2,f=r[s]/2-i[s]/2,p;switch(c){case`top`:p={x:u,y:r.y-i.height};break;case`bottom`:p={x:u,y:r.y+r.height};break;case`right`:p={x:r.x+r.width,y:d};break;case`left`:p={x:r.x-i.width,y:d};break;default:p={x:r.x,y:r.y}}let m=fi(t);return m&&(p[o]+=f*(m===`end`?1:-1)*(n&&l?-1:1)),p}async function ji(e,t){t===void 0&&(t={});let{x:n,y:r,platform:i,rects:a,elements:o,strategy:s}=e,{boundary:c=`clippingAncestors`,rootBoundary:l=`viewport`,elementContext:u=`floating`,altBoundary:d=!1,padding:f=0}=ui(t,e),p=Oi(f),m=o[d?u===`floating`?`reference`:`floating`:u],h=ki(await i.getClippingRect({element:await(i.isElement==null?void 0:i.isElement(m))??!0?m:m.contextElement||await(i.getDocumentElement==null?void 0:i.getDocumentElement(o.floating)),boundary:c,rootBoundary:l,strategy:s})),g=u===`floating`?{x:n,y:r,width:a.floating.width,height:a.floating.height}:a.reference,_=await(i.getOffsetParent==null?void 0:i.getOffsetParent(o.floating)),v=await(i.isElement==null?void 0:i.isElement(_))&&await(i.getScale==null?void 0:i.getScale(_))||{x:1,y:1},y=ki(i.convertOffsetParentRelativeRectToViewportRelativeRect?await i.convertOffsetParentRelativeRectToViewportRelativeRect({elements:o,rect:g,offsetParent:_,strategy:s}):g);return{top:(h.top-y.top+p.top)/v.y,bottom:(y.bottom-h.bottom+p.bottom)/v.y,left:(h.left-y.left+p.left)/v.x,right:(y.right-h.right+p.right)/v.x}}var Mi=50,Ni=async(e,t,n)=>{let{placement:r=`bottom`,strategy:i=`absolute`,middleware:a=[],platform:o}=n,s=o.detectOverflow?o:{...o,detectOverflow:ji},c=await(o.isRTL==null?void 0:o.isRTL(t)),l=await o.getElementRects({reference:e,floating:t,strategy:i}),{x:u,y:d}=Ai(l,r,c),f=r,p=0,m={};for(let n=0;n<a.length;n++){let h=a[n];if(!h)continue;let{name:g,fn:_}=h,{x:v,y,data:b,reset:x}=await _({x:u,y:d,initialPlacement:r,placement:f,strategy:i,middlewareData:m,rects:l,platform:s,elements:{reference:e,floating:t}});u=v??u,d=y??d,m[g]={...m[g],...b},x&&p<Mi&&(p++,typeof x==`object`&&(x.placement&&(f=x.placement),x.rects&&(l=x.rects===!0?await o.getElementRects({reference:e,floating:t,strategy:i}):x.rects),{x:u,y:d}=Ai(l,f,c)),n=-1)}return{x:u,y:d,placement:f,strategy:i,middlewareData:m}},Pi=e=>({name:`arrow`,options:e,async fn(t){let{x:n,y:r,placement:i,rects:a,platform:o,elements:s,middlewareData:c}=t,{element:l,padding:u=0}=ui(e,t)||{};if(l==null)return{};let d=Oi(u),f={x:n,y:r},p=gi(i),m=mi(p),h=await o.getDimensions(l),g=p===`y`,_=g?`top`:`left`,v=g?`bottom`:`right`,y=g?`clientHeight`:`clientWidth`,b=a.reference[m]+a.reference[p]-f[p]-a.floating[m],x=f[p]-a.reference[p],ee=await(o.getOffsetParent==null?void 0:o.getOffsetParent(l)),S=ee?ee[y]:0;(!S||!await(o.isElement==null?void 0:o.isElement(ee)))&&(S=s.floating[y]||a.floating[m]);let te=b/2-x/2,C=S/2-h[m]/2-1,ne=ri(d[_],C),re=ri(d[v],C),w=S-h[m]-re,ie=S/2-h[m]/2+te,ae=li(ne,ie,w),oe=!c.arrow&&fi(i)!=null&&ie!==ae&&a.reference[m]/2-(ie<ne?ne:re)-h[m]/2<0,se=oe?ie<ne?ie-ne:ie-w:0;return{[p]:f[p]+se,data:{[p]:ae,centerOffset:ie-ae-se,...oe&&{alignmentOffset:se}},reset:oe}}}),Fi=function(e){return e===void 0&&(e={}),{name:`flip`,options:e,async fn(t){var n;let{placement:r,middlewareData:i,rects:a,initialPlacement:o,platform:s,elements:c}=t,{mainAxis:l=!0,crossAxis:u=!0,fallbackPlacements:d,fallbackStrategy:f=`bestFit`,fallbackAxisSideDirection:p=`none`,flipAlignment:m=!0,...h}=ui(e,t);if((n=i.arrow)!=null&&n.alignmentOffset)return{};let g=di(r),_=hi(o),v=di(o)===o,y=await(s.isRTL==null?void 0:s.isRTL(c.floating)),b=d||(v||!m?[Ei(o)]:vi(o)),x=p!==`none`;!d&&x&&b.push(...Ti(o,m,p,y));let ee=[o,...b],S=await s.detectOverflow(t,h),te=[],C=i.flip?.overflows||[];if(l&&te.push(S[g]),u){let e=_i(r,a,y);te.push(S[e[0]],S[e[1]])}if(C=[...C,{placement:r,overflows:te}],!te.every(e=>e<=0)){let e=(i.flip?.index||0)+1,t=ee[e];if(t&&(u!==`alignment`||_===hi(t)||C.every(e=>hi(e.placement)!==_||e.overflows[0]>0)))return{data:{index:e,overflows:C},reset:{placement:t}};let n=C.filter(e=>e.overflows[0]<=0).sort((e,t)=>e.overflows[1]-t.overflows[1])[0]?.placement;if(!n)switch(f){case`bestFit`:{let e=C.filter(e=>{if(x){let t=hi(e.placement);return t===_||t===`y`}return!0}).map(e=>[e.placement,e.overflows.filter(e=>e>0).reduce((e,t)=>e+t,0)]).sort((e,t)=>e[1]-t[1])[0]?.[0];e&&(n=e);break}case`initialPlacement`:n=o}if(r!==n)return{reset:{placement:n}}}return{}}}},Ii=new Set([`left`,`top`]);async function Li(e,t){let{placement:n,platform:r,elements:i}=e,a=await(r.isRTL==null?void 0:r.isRTL(i.floating)),o=di(n),s=fi(n),c=hi(n)===`y`,l=Ii.has(o)?-1:1,u=a&&c?-1:1,d=ui(t,e),{mainAxis:f,crossAxis:p,alignmentAxis:m}=typeof d==`number`?{mainAxis:d,crossAxis:0,alignmentAxis:null}:{mainAxis:d.mainAxis||0,crossAxis:d.crossAxis||0,alignmentAxis:d.alignmentAxis};return s&&typeof m==`number`&&(p=s===`end`?m*-1:m),c?{x:p*u,y:f*l}:{x:f*l,y:p*u}}var Ri=function(e){return e===void 0&&(e=0),{name:`offset`,options:e,async fn(t){var n;let{x:r,y:i,placement:a,middlewareData:o}=t,s=await Li(t,e);return a===o.offset?.placement&&(n=o.arrow)!=null&&n.alignmentOffset?{}:{x:r+s.x,y:i+s.y,data:{...s,placement:a}}}}},zi=function(e){return e===void 0&&(e={}),{name:`shift`,options:e,async fn(t){let{x:n,y:r,placement:i,platform:a}=t,{mainAxis:o=!0,crossAxis:s=!1,limiter:c={fn:e=>{let{x:t,y:n}=e;return{x:t,y:n}}},...l}=ui(e,t),u={x:n,y:r},d=await a.detectOverflow(t,l),f=hi(i),p=pi(f),m=u[p],h=u[f],g=(e,t)=>li(t+d[e===`y`?`top`:`left`],t,t-d[e===`y`?`bottom`:`right`]);o&&(m=g(p,m)),s&&(h=g(f,h));let _=c.fn({...t,[p]:m,[f]:h});return{..._,data:{x:_.x-n,y:_.y-r,enabled:{[p]:o,[f]:s}}}}}},Bi=function(e){return e===void 0&&(e={}),{name:`size`,options:e,async fn(t){let{placement:n,rects:r,platform:i,elements:a}=t,{apply:o=()=>{},...s}=ui(e,t),c=await i.detectOverflow(t,s),l=di(n),u=fi(n),d=hi(n)===`y`,{width:f,height:p}=r.floating,m,h;l===`top`||l===`bottom`?(m=l,h=u===(await(i.isRTL==null?void 0:i.isRTL(a.floating))?`start`:`end`)?`left`:`right`):(h=l,m=u===`end`?`top`:`bottom`);let g=p-c.top-c.bottom,_=f-c.left-c.right,v=ri(p-c[m],g),y=ri(f-c[h],_),b=t.middlewareData.shift,x=!b,ee=v,S=y;b!=null&&b.enabled.x&&(S=_),b!=null&&b.enabled.y&&(ee=g),x&&!u&&(d?S=f-2*ii(c.left,c.right):ee=p-2*ii(c.top,c.bottom)),await o({...t,availableWidth:S,availableHeight:ee});let te=await i.getDimensions(a.floating);return f!==te.width||p!==te.height?{reset:{rects:!0}}:{}}}};function Vi(){return typeof window<`u`}function Hi(e){return Wi(e)?(e.nodeName||``).toLowerCase():`#document`}function X(e){var t;return(e==null||(t=e.ownerDocument)==null?void 0:t.defaultView)||window}function Ui(e){return((Wi(e)?e.ownerDocument:e.document)||window.document)?.documentElement}function Wi(e){return Vi()?e instanceof Node||e instanceof X(e).Node:!1}function Gi(e){return Vi()?e instanceof Element||e instanceof X(e).Element:!1}function Ki(e){return Vi()?e instanceof HTMLElement||e instanceof X(e).HTMLElement:!1}function qi(e){return!Vi()||typeof ShadowRoot>`u`?!1:e instanceof ShadowRoot||e instanceof X(e).ShadowRoot}function Ji(e){let{overflow:t,overflowX:n,overflowY:r,display:i}=Z(e);return/auto|scroll|overlay|hidden|clip/.test(t+r+n)&&i!==`inline`&&i!==`contents`}function Yi(e){return/^(table|td|th)$/.test(Hi(e))}function Xi(e){try{if(e.matches(`:popover-open`))return!0}catch{}try{return e.matches(`:modal`)}catch{return!1}}var Zi=/transform|translate|scale|rotate|perspective|filter/,Qi=/paint|layout|strict|content/,$i=e=>!!e&&e!==`none`,ea;function ta(e){let t=Gi(e)?Z(e):e;return $i(t.transform)||$i(t.translate)||$i(t.scale)||$i(t.rotate)||$i(t.perspective)||!ra()&&($i(t.backdropFilter)||$i(t.filter))||Zi.test(t.willChange||``)||Qi.test(t.contain||``)}function na(e){let t=oa(e);for(;Ki(t)&&!ia(t);){if(ta(t))return t;if(Xi(t))return null;t=oa(t)}return null}function ra(){return ea??=typeof CSS<`u`&&CSS.supports&&CSS.supports(`-webkit-backdrop-filter`,`none`),ea}function ia(e){return/^(html|body|#document)$/.test(Hi(e))}function Z(e){return X(e).getComputedStyle(e)}function aa(e){return Gi(e)?{scrollLeft:e.scrollLeft,scrollTop:e.scrollTop}:{scrollLeft:e.scrollX,scrollTop:e.scrollY}}function oa(e){if(Hi(e)===`html`)return e;let t=e.assignedSlot||e.parentNode||qi(e)&&e.host||Ui(e);return qi(t)?t.host:t}function sa(e){let t=oa(e);return ia(t)?(e.ownerDocument||e).body:Ki(t)&&Ji(t)?t:sa(t)}function ca(e,t,n){t===void 0&&(t=[]),n===void 0&&(n=!0);let r=sa(e),i=r===e.ownerDocument?.body,a=X(r);if(i){let e=la(a);return t.concat(a,a.visualViewport||[],Ji(r)?r:[],e&&n?ca(e):[])}return t.concat(r,ca(r,[],n))}function la(e){return e.parent&&Object.getPrototypeOf(e.parent)?e.frameElement:null}function ua(e){let t=Z(e),n=parseFloat(t.width)||0,r=parseFloat(t.height)||0,i=Ki(e),a=i?e.offsetWidth:n,o=i?e.offsetHeight:r,s=ai(n)!==a||ai(r)!==o;return s&&(n=a,r=o),{width:n,height:r,$:s}}function da(e){return Gi(e)?e:e.contextElement}function fa(e){let t=da(e);if(!Ki(t))return si(1);let n=t.getBoundingClientRect(),{width:r,height:i,$:a}=ua(t),o=(a?ai(n.width):n.width)/r,s=(a?ai(n.height):n.height)/i;return(!o||!Number.isFinite(o))&&(o=1),(!s||!Number.isFinite(s))&&(s=1),{x:o,y:s}}var pa=si(0);function ma(e){let t=X(e);return!ra()||!t.visualViewport?pa:{x:t.visualViewport.offsetLeft,y:t.visualViewport.offsetTop}}function ha(e,t,n){return t===void 0&&(t=!1),!!n&&t&&n===X(e)}function ga(e,t,n,r){t===void 0&&(t=!1),n===void 0&&(n=!1);let i=e.getBoundingClientRect(),a=da(e),o=si(1);t&&(r?Gi(r)&&(o=fa(r)):o=fa(e));let s=ha(a,n,r)?ma(a):si(0),c=(i.left+s.x)/o.x,l=(i.top+s.y)/o.y,u=i.width/o.x,d=i.height/o.y;if(a&&r){let e=X(a),t=Gi(r)?X(r):r,n=e,i=la(n);for(;i&&t!==n;){let e=fa(i),t=i.getBoundingClientRect(),r=Z(i),a=t.left+(i.clientLeft+parseFloat(r.paddingLeft))*e.x,o=t.top+(i.clientTop+parseFloat(r.paddingTop))*e.y;c*=e.x,l*=e.y,u*=e.x,d*=e.y,c+=a,l+=o,n=X(i),i=la(n)}}return ki({width:u,height:d,x:c,y:l})}function _a(e,t){let n=aa(e).scrollLeft;return t?t.left+n:ga(Ui(e)).left+n}function va(e,t){let n=e.getBoundingClientRect();return{x:n.left+t.scrollLeft-_a(e,n),y:n.top+t.scrollTop}}function ya(e){let{elements:t,rect:n,offsetParent:r,strategy:i}=e,a=i===`fixed`,o=Ui(r),s=t?Xi(t.floating):!1;if(r===o||s&&a)return n;let c={scrollLeft:0,scrollTop:0},l=si(1),u=si(0),d=Ki(r);if((d||!a)&&((Hi(r)!==`body`||Ji(o))&&(c=aa(r)),d)){let e=ga(r);l=fa(r),u.x=e.x+r.clientLeft,u.y=e.y+r.clientTop}let f=o&&!d&&!a?va(o,c):si(0);return{width:n.width*l.x,height:n.height*l.y,x:n.x*l.x-c.scrollLeft*l.x+u.x+f.x,y:n.y*l.y-c.scrollTop*l.y+u.y+f.y}}function ba(e){return e.getClientRects?Array.from(e.getClientRects()):[]}function xa(e){let t=aa(e),n=e.ownerDocument.body,r=ii(e.scrollWidth,e.clientWidth,n.scrollWidth,n.clientWidth),i=ii(e.scrollHeight,e.clientHeight,n.scrollHeight,n.clientHeight),a=-t.scrollLeft+_a(e),o=-t.scrollTop;return Z(n).direction===`rtl`&&(a+=ii(e.clientWidth,n.clientWidth)-r),{width:r,height:i,x:a,y:o}}var Sa=25;function Ca(e,t,n){n===void 0&&(n=`viewport`);let r=n===`layoutViewport`,i=X(e),a=Ui(e),o=i.visualViewport,s=a.clientWidth,c=a.clientHeight,l=0,u=0;if(o){let e=!ra()||t===`fixed`;r?e||(l=-o.offsetLeft,u=-o.offsetTop):(s=o.width,c=o.height,e&&(l=o.offsetLeft,u=o.offsetTop))}if(_a(a)<=0){let e=a.ownerDocument,t=e.body,n=getComputedStyle(t),r=e.compatMode===`CSS1Compat`&&parseFloat(n.marginLeft)+parseFloat(n.marginRight)||0,i=Math.abs(a.clientWidth-t.clientWidth-r),o=getComputedStyle(a).scrollbarGutter===`stable both-edges`?i/2:i;o<=Sa&&(s-=o)}return{width:s,height:c,x:l,y:u}}function wa(e,t){let n=ga(e,!0,t===`fixed`),r=n.top+e.clientTop,i=n.left+e.clientLeft,a=fa(e);return{width:e.clientWidth*a.x,height:e.clientHeight*a.y,x:i*a.x,y:r*a.y}}function Ta(e,t,n){let r;if(t===`viewport`||t===`layoutViewport`)r=Ca(e,n,t);else if(t===`document`)r=xa(Ui(e));else if(Gi(t))r=wa(t,n);else{let n=ma(e);r={x:t.x-n.x,y:t.y-n.y,width:t.width,height:t.height}}return ki(r)}function Ea(e,t){let n=t.get(e);if(n)return n;let r=ca(e,[],!1).filter(e=>Gi(e)&&Hi(e)!==`body`),i=null,a=Z(e).position===`fixed`,o=a?oa(e):e;for(;Gi(o)&&!ia(o);){let e=Z(o),t=ta(o),n=i?i.position:a?`fixed`:``;!t&&(n===`fixed`||n===`absolute`&&e.position===`static`)?r=r.filter(e=>e!==o):i=e,o=oa(o)}return t.set(e,r),r}function Da(e){let{element:t,boundary:n,rootBoundary:r,strategy:i}=e,a=[...n===`clippingAncestors`?Xi(t)?[]:Ea(t,this._c):[].concat(n),r],o=Ta(t,a[0],i),s=o.top,c=o.right,l=o.bottom,u=o.left;for(let e=1;e<a.length;e++){let n=Ta(t,a[e],i);s=ii(n.top,s),c=ri(n.right,c),l=ri(n.bottom,l),u=ii(n.left,u)}return{width:c-u,height:l-s,x:u,y:s}}function Oa(e){let{width:t,height:n}=ua(e);return{width:t,height:n}}function ka(e,t,n){let r=Ki(t),i=Ui(t),a=n===`fixed`,o=ga(e,!0,a,t),s={scrollLeft:0,scrollTop:0},c=si(0);if((r||!a)&&((Hi(t)!==`body`||Ji(i))&&(s=aa(t)),r)){let e=ga(t,!0,a,t);c.x=e.x+t.clientLeft,c.y=e.y+t.clientTop}!r&&i&&(c.x=_a(i));let l=i&&!r&&!a?va(i,s):si(0);return{x:o.left+s.scrollLeft-c.x-l.x,y:o.top+s.scrollTop-c.y-l.y,width:o.width,height:o.height}}function Aa(e){return Z(e).position===`static`}function ja(e,t){if(!Ki(e)||Z(e).position===`fixed`)return null;if(t)return t(e);let n=e.offsetParent;return Ui(e)===n&&(n=n.ownerDocument.body),n}function Ma(e,t){let n=X(e);if(Xi(e))return n;if(!Ki(e)){let t=oa(e);for(;t&&!ia(t);){if(Gi(t)&&!Aa(t))return t;t=oa(t)}return n}let r=ja(e,t);for(;r&&Yi(r)&&Aa(r);)r=ja(r,t);return r&&ia(r)&&Aa(r)&&!ta(r)?n:r||na(e)||n}var Na=async function(e){let t=this.getOffsetParent||Ma,n=this.getDimensions,r=await n(e.floating);return{reference:ka(e.reference,await t(e.floating),e.strategy),floating:{x:0,y:0,width:r.width,height:r.height}}};function Pa(e){return Z(e).direction===`rtl`}var Fa={convertOffsetParentRelativeRectToViewportRelativeRect:ya,getDocumentElement:Ui,getClippingRect:Da,getOffsetParent:Ma,getElementRects:Na,getClientRects:ba,getDimensions:Oa,getScale:fa,isElement:Gi,isRTL:Pa};function Ia(e,t){return e.x===t.x&&e.y===t.y&&e.width===t.width&&e.height===t.height}function La(e,t,n){let r=null,i,a=Ui(e);function o(){var e;clearTimeout(i),(e=r)==null||e.disconnect(),r=null}function s(n,c){n===void 0&&(n=!1),c===void 0&&(c=1),o();let l=e.getBoundingClientRect(),{left:u,top:d,width:f,height:p}=l;if(n||t(),!f||!p)return;let m=oi(d),h=oi(a.clientWidth-(u+f)),g=oi(a.clientHeight-(d+p)),_=oi(u),v={rootMargin:-m+`px `+-h+`px `+-g+`px `+-_+`px`,threshold:ii(0,ri(1,c))||1},y=!0;function b(t){let n=t[0].intersectionRatio;if(!Ia(l,e.getBoundingClientRect()))return s();if(n!==c){if(!y)return s();n?s(!1,n):i=setTimeout(()=>{s(!1,1e-7)},1e3)}y=!1}try{r=new IntersectionObserver(b,{...v,root:a.ownerDocument})}catch{r=new IntersectionObserver(b,v)}r.observe(e)}let c=X(e),l=()=>s(n);return c.addEventListener(`resize`,l),s(!0),()=>{c.removeEventListener(`resize`,l),o()}}function Ra(e,t,n,r){r===void 0&&(r={});let{ancestorScroll:i=!0,ancestorResize:a=!0,elementResize:o=typeof ResizeObserver==`function`,layoutShift:s=typeof IntersectionObserver==`function`,animationFrame:c=!1}=r,l=da(e),u=i||a?[...l?ca(l):[],...t?ca(t):[]]:[];u.forEach(e=>{i&&e.addEventListener(`scroll`,n),a&&e.addEventListener(`resize`,n)});let d=l&&s?La(l,n,a):null,f=-1,p=null;o&&(p=new ResizeObserver(e=>{let[r]=e;r&&r.target===l&&p&&t&&(p.unobserve(t),cancelAnimationFrame(f),f=requestAnimationFrame(()=>{var e;(e=p)==null||e.observe(t)})),n()}),l&&!c&&p.observe(l),t&&p.observe(t));let m,h=c?ga(e):null;c&&g();function g(){let t=ga(e);h&&!Ia(h,t)&&n(),h=t,m=requestAnimationFrame(g)}return n(),()=>{var e;u.forEach(e=>{i&&e.removeEventListener(`scroll`,n),a&&e.removeEventListener(`resize`,n)}),d?.(),(e=p)==null||e.disconnect(),p=null,c&&cancelAnimationFrame(m)}}var za=Ri,Ba=zi,Va=Fi,Ha=Bi,Ua=Pi,Wa=(e,t,n)=>{let r=new Map,i=n??{},a={...Fa,...i.platform,_c:r};return Ni(e,t,{...i,platform:a})};function Ga(e){return qa(e)}function Ka(e){return e.assignedSlot?e.assignedSlot:e.parentNode instanceof ShadowRoot?e.parentNode.host:e.parentNode}function qa(e){for(let t=e;t;t=Ka(t))if(t instanceof Element&&getComputedStyle(t).display===`none`)return null;for(let t=Ka(e);t;t=Ka(t)){if(!(t instanceof Element))continue;let e=getComputedStyle(t);if(e.display!==`contents`&&(e.position!==`static`||ta(e)||t.tagName===`BODY`))return t}return null}function Ja(e){return typeof e==`object`&&!!e&&`getBoundingClientRect`in e&&(`contextElement`in e?e instanceof Element:!0)}var Ya=!!globalThis?.HTMLElement?.prototype.hasOwnProperty(`popover`),Q=class extends z{constructor(){super(...arguments),this.localize=new vr(this),this.SUPPORTS_POPOVER=!1,this.active=!1,this.placement=`top`,this.boundary=`viewport`,this.distance=0,this.skidding=0,this.arrow=!1,this.arrowPlacement=`anchor`,this.arrowPadding=10,this.flip=!1,this.flipFallbackPlacements=``,this.flipFallbackStrategy=`best-fit`,this.flipPadding=0,this.shift=!1,this.shiftPadding=0,this.autoSizePadding=0,this.hoverBridge=!1,this.updateHoverBridge=()=>{if(this.hoverBridge&&this.anchorEl&&this.popup){let e=this.anchorEl.getBoundingClientRect(),t=this.popup.getBoundingClientRect(),n=this.placement.includes(`top`)||this.placement.includes(`bottom`),r=0,i=0,a=0,o=0,s=0,c=0,l=0,u=0;n?e.top<t.top?(r=e.left,i=e.bottom,a=e.right,o=e.bottom,s=t.left,c=t.top,l=t.right,u=t.top):(r=t.left,i=t.bottom,a=t.right,o=t.bottom,s=e.left,c=e.top,l=e.right,u=e.top):e.left<t.left?(r=e.right,i=e.top,a=t.left,o=t.top,s=e.right,c=e.bottom,l=t.left,u=t.bottom):(r=t.right,i=t.top,a=e.left,o=e.top,s=t.right,c=t.bottom,l=e.left,u=e.bottom),this.style.setProperty(`--hover-bridge-top-left-x`,`${r}px`),this.style.setProperty(`--hover-bridge-top-left-y`,`${i}px`),this.style.setProperty(`--hover-bridge-top-right-x`,`${a}px`),this.style.setProperty(`--hover-bridge-top-right-y`,`${o}px`),this.style.setProperty(`--hover-bridge-bottom-left-x`,`${s}px`),this.style.setProperty(`--hover-bridge-bottom-left-y`,`${c}px`),this.style.setProperty(`--hover-bridge-bottom-right-x`,`${l}px`),this.style.setProperty(`--hover-bridge-bottom-right-y`,`${u}px`)}}}async connectedCallback(){super.connectedCallback(),await this.updateComplete,this.SUPPORTS_POPOVER=Ya,this.start()}disconnectedCallback(){super.disconnectedCallback(),this.stop()}async updated(e){super.updated(e),e.has(`active`)&&(this.active?this.start():this.stop()),e.has(`anchor`)&&this.handleAnchorChange(),this.active&&(await this.updateComplete,this.reposition())}async handleAnchorChange(){if(await this.stop(),this.anchor&&typeof this.anchor==`string`){let e=this.getRootNode();this.anchorEl=e.getElementById(this.anchor)}else this.anchorEl=this.anchor instanceof Element||Ja(this.anchor)?this.anchor:this.querySelector(`[slot="anchor"]`);this.anchorEl instanceof HTMLSlotElement&&(this.anchorEl=this.anchorEl.assignedElements({flatten:!0})[0]),this.anchorEl&&this.start()}start(){!this.anchorEl||!this.active||!this.isConnected||(this.popup?.showPopover?.(),this.cleanup=Ra(this.anchorEl,this.popup,()=>{this.reposition()}))}async stop(){return new Promise(e=>{this.popup?.hidePopover?.(),this.cleanup?(this.cleanup(),this.cleanup=void 0,this.removeAttribute(`data-current-placement`),this.style.removeProperty(`--auto-size-available-width`),this.style.removeProperty(`--auto-size-available-height`),requestAnimationFrame(()=>e())):e()})}reposition(){if(!this.active||!this.anchorEl||!this.popup)return;let e=[za({mainAxis:this.distance,crossAxis:this.skidding})];this.sync?e.push(Ha({apply:({rects:e})=>{let t=this.sync===`width`||this.sync===`both`,n=this.sync===`height`||this.sync===`both`;this.popup.style.width=t?`${e.reference.width}px`:``,this.popup.style.height=n?`${e.reference.height}px`:``}})):(this.popup.style.width=``,this.popup.style.height=``);let t;this.SUPPORTS_POPOVER&&!Ja(this.anchor)&&this.boundary===`scroll`&&(t=ca(this.anchorEl).filter(e=>e instanceof Element)),this.flip&&e.push(Va({boundary:this.flipBoundary||t,fallbackPlacements:this.flipFallbackPlacements,fallbackStrategy:this.flipFallbackStrategy===`best-fit`?`bestFit`:`initialPlacement`,padding:this.flipPadding})),this.shift&&e.push(Ba({boundary:this.shiftBoundary||t,padding:this.shiftPadding})),this.autoSize?e.push(Ha({boundary:this.autoSizeBoundary||t,padding:this.autoSizePadding,apply:({availableWidth:e,availableHeight:t})=>{this.autoSize===`vertical`||this.autoSize===`both`?this.style.setProperty(`--auto-size-available-height`,`${t}px`):this.style.removeProperty(`--auto-size-available-height`),this.autoSize===`horizontal`||this.autoSize===`both`?this.style.setProperty(`--auto-size-available-width`,`${e}px`):this.style.removeProperty(`--auto-size-available-width`)}})):(this.style.removeProperty(`--auto-size-available-width`),this.style.removeProperty(`--auto-size-available-height`)),this.arrow&&e.push(Ua({element:this.arrowEl,padding:this.arrowPadding}));let n=this.SUPPORTS_POPOVER?e=>Fa.getOffsetParent(e,Ga):Fa.getOffsetParent;Wa(this.anchorEl,this.popup,{placement:this.placement,middleware:e,strategy:this.SUPPORTS_POPOVER?`absolute`:`fixed`,platform:{...Fa,getOffsetParent:n}}).then(({x:e,y:t,middlewareData:n,placement:r})=>{let i=this.localize.dir()===`rtl`,a={top:`bottom`,right:`left`,bottom:`top`,left:`right`}[r.split(`-`)[0]];if(this.setAttribute(`data-current-placement`,r),Object.assign(this.popup.style,{left:`${e}px`,top:`${t}px`}),this.arrow){let e=n.arrow.x,t=n.arrow.y,r=``,o=``,s=``,c=``;if(this.arrowPlacement===`start`){let n=typeof e==`number`?`calc(${this.arrowPadding}px - var(--arrow-padding-offset))`:``;r=typeof t==`number`?`calc(${this.arrowPadding}px - var(--arrow-padding-offset))`:``,o=i?n:``,c=i?``:n}else if(this.arrowPlacement===`end`){let n=typeof e==`number`?`calc(${this.arrowPadding}px - var(--arrow-padding-offset))`:``;o=i?``:n,c=i?n:``,s=typeof t==`number`?`calc(${this.arrowPadding}px - var(--arrow-padding-offset))`:``}else this.arrowPlacement===`center`?(c=typeof e==`number`?`calc(50% - var(--arrow-size-diagonal))`:``,r=typeof t==`number`?`calc(50% - var(--arrow-size-diagonal))`:``):(c=typeof e==`number`?`${e}px`:``,r=typeof t==`number`?`${t}px`:``);Object.assign(this.arrowEl.style,{top:r,right:o,bottom:s,left:c,[a]:`calc(var(--arrow-base-offset) - var(--arrow-size-diagonal))`})}}),requestAnimationFrame(()=>this.updateHoverBridge()),this.dispatchEvent(new ti)}render(){return j`
      <slot name="anchor" @slotchange=${this.handleAnchorChange}></slot>

      <span
        part="hover-bridge"
        class=${U({"popup-hover-bridge":!0,"popup-hover-bridge-visible":this.hoverBridge&&this.active})}
      ></span>

      <div
        popover="manual"
        part="popup"
        class=${U({popup:!0,"popup-active":this.active,"popup-fixed":!this.SUPPORTS_POPOVER,"popup-has-arrow":this.arrow})}
      >
        <slot></slot>
        ${this.arrow?j`<div part="arrow" class="arrow" role="presentation"></div>`:``}
      </div>
    `}};Q.css=ni,P([R(`.popup`)],Q.prototype,`popup`,2),P([R(`.arrow`)],Q.prototype,`arrowEl`,2),P([I({attribute:!1,type:Boolean})],Q.prototype,`SUPPORTS_POPOVER`,2),P([I()],Q.prototype,`anchor`,2),P([I({type:Boolean,reflect:!0})],Q.prototype,`active`,2),P([I({reflect:!0})],Q.prototype,`placement`,2),P([I()],Q.prototype,`boundary`,2),P([I({type:Number})],Q.prototype,`distance`,2),P([I({type:Number})],Q.prototype,`skidding`,2),P([I({type:Boolean})],Q.prototype,`arrow`,2),P([I({attribute:`arrow-placement`})],Q.prototype,`arrowPlacement`,2),P([I({attribute:`arrow-padding`,type:Number})],Q.prototype,`arrowPadding`,2),P([I({type:Boolean})],Q.prototype,`flip`,2),P([I({attribute:`flip-fallback-placements`,converter:{fromAttribute:e=>e.split(` `).map(e=>e.trim()).filter(e=>e!==``),toAttribute:e=>e.join(` `)}})],Q.prototype,`flipFallbackPlacements`,2),P([I({attribute:`flip-fallback-strategy`})],Q.prototype,`flipFallbackStrategy`,2),P([I({type:Object})],Q.prototype,`flipBoundary`,2),P([I({attribute:`flip-padding`,type:Number})],Q.prototype,`flipPadding`,2),P([I({type:Boolean})],Q.prototype,`shift`,2),P([I({type:Object})],Q.prototype,`shiftBoundary`,2),P([I({attribute:`shift-padding`,type:Number})],Q.prototype,`shiftPadding`,2),P([I({attribute:`auto-size`})],Q.prototype,`autoSize`,2),P([I()],Q.prototype,`sync`,2),P([I({type:Object})],Q.prototype,`autoSizeBoundary`,2),P([I({attribute:`auto-size-padding`,type:Number})],Q.prototype,`autoSizePadding`,2),P([I({attribute:`hover-bridge`,type:Boolean})],Q.prototype,`hoverBridge`,2),Q=P([F(`wa-popup`)],Q);var Xa=w`
  @layer wa-component {
    :host {
      display: inline-block;

      /* Workaround because Chrome doesn't like :host(:has()) below
       * https://issues.chromium.org/issues/40062355
       * Firefox doesn't like this nested rule, so both are needed */
      &:has(wa-badge) {
        position: relative;
      }
    }

    /* Apply relative positioning only when needed to position wa-badge
     * This avoids creating a new stacking context for every button */
    :host(:has(wa-badge)) {
      position: relative;
    }
  }

  .button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    text-decoration: none;
    user-select: none;
    -webkit-user-select: none;
    white-space: nowrap;
    vertical-align: middle;
    transition-property: background, border, box-shadow, color, opacity, transform;
    transition-duration: var(--wa-transition-fast);
    transition-timing-function: var(--wa-transition-easing);
    transform-origin: center;
    cursor: pointer;
    padding: 0 var(--wa-form-control-padding-inline);
    font-family: inherit;
    font-size: inherit;
    font-weight: var(--wa-font-weight-action);
    height: var(--wa-form-control-height);
    width: 100%;

    background-color: var(--wa-color-fill-loud, var(--wa-color-neutral-fill-loud));

    border-color: transparent;
    color: var(--wa-color-on-loud, var(--wa-color-neutral-on-loud));
    border-start-start-radius: var(--_button-start-start-radius, var(--wa-form-control-border-radius));
    border-start-end-radius: var(--_button-start-end-radius, var(--wa-form-control-border-radius));
    border-end-start-radius: var(--_button-end-start-radius, var(--wa-form-control-border-radius));
    border-end-end-radius: var(--_button-end-end-radius, var(--wa-form-control-border-radius));
    border-style: var(--wa-form-control-border-style);
    border-width: var(--wa-form-control-border-width);
  }

  /* Hover and active transforms */
  .button:not(.disabled):not(.loading) {
    @media (hover: hover) {
      &:hover {
        transform: var(--wa-button-transform-hover);
      }
    }
    &:active {
      transform: var(--wa-button-transform-active);
    }

    @media (prefers-reduced-motion: reduce) {
      &:hover,
      &:active {
        transform: none;
      }
    }
  }

  /* Appearance modifiers */
  :host([appearance='plain']) {
    /* Indentation overrides for grouping */
    margin-inline-start: var(--_button-horizontal-indent);
    margin-block-start: var(--_button-vertical-indent);

    .button {
      color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
      background-color: transparent;
      border-color: transparent;
    }
    @media (hover: hover) {
      .button:not(.disabled):not(.loading):hover {
        color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
        background-color: var(--wa-color-fill-quiet, var(--wa-color-neutral-fill-quiet));
      }
    }
    .button:not(.disabled):not(.loading):active {
      color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
      background-color: color-mix(
        in oklab,
        var(--wa-color-fill-quiet, var(--wa-color-neutral-fill-quiet)),
        var(--wa-color-mix-active)
      );
    }
  }

  :host([appearance='outlined']) {
    /* Indentation overrides for grouping outlined */
    margin-inline-start: var(--_button-horizontal-indent-outlined);
    margin-block-start: var(--_button-vertical-indent-outlined);

    .button {
      color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
      background-color: transparent;
      border-color: var(--wa-color-border-loud, var(--wa-color-neutral-border-loud));
    }
    @media (hover: hover) {
      .button:not(.disabled):not(.loading):hover {
        color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
        background-color: var(--wa-color-fill-quiet, var(--wa-color-neutral-fill-quiet));
      }
    }
    .button:not(.disabled):not(.loading):active {
      color: var(--wa-color-on-quiet, var(--wa-color-neutral-on-quiet));
      background-color: color-mix(
        in oklab,
        var(--wa-color-fill-quiet, var(--wa-color-neutral-fill-quiet)),
        var(--wa-color-mix-active)
      );
    }
  }

  :host([appearance='filled']) {
    /* Indentation overrides for grouping */
    margin-inline-start: var(--_button-horizontal-indent);
    margin-block-start: var(--_button-vertical-indent);

    .button {
      color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
      background-color: var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal));
      border-color: transparent;
    }
    @media (hover: hover) {
      .button:not(.disabled):not(.loading):hover {
        color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
        background-color: color-mix(
          in oklab,
          var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal)),
          var(--wa-color-mix-hover)
        );
      }
    }
    .button:not(.disabled):not(.loading):active {
      color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
      background-color: color-mix(
        in oklab,
        var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal)),
        var(--wa-color-mix-active)
      );
    }
  }

  :host([appearance='filled-outlined']) {
    /* Indentation overrides for grouping outlined */
    margin-inline-start: var(--_button-horizontal-indent-outlined);
    margin-block-start: var(--_button-vertical-indent-outlined);

    .button {
      color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
      background-color: var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal));
      border-color: var(--wa-color-border-normal, var(--wa-color-neutral-border-normal));
    }
    @media (hover: hover) {
      .button:not(.disabled):not(.loading):hover {
        color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
        background-color: color-mix(
          in oklab,
          var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal)),
          var(--wa-color-mix-hover)
        );
      }
    }
    .button:not(.disabled):not(.loading):active {
      color: var(--wa-color-on-normal, var(--wa-color-neutral-on-normal));
      background-color: color-mix(
        in oklab,
        var(--wa-color-fill-normal, var(--wa-color-neutral-fill-normal)),
        var(--wa-color-mix-active)
      );
    }
  }

  :host([appearance='accent']) {
    /* Indentation overrides for grouping */
    margin-inline-start: var(--_button-horizontal-indent);
    margin-block-start: var(--_button-vertical-indent);

    .button {
      color: var(--wa-color-on-loud, var(--wa-color-neutral-on-loud));
      background-color: var(--wa-color-fill-loud, var(--wa-color-neutral-fill-loud));
      border-color: transparent;
    }
    @media (hover: hover) {
      .button:not(.disabled):not(.loading):hover {
        background-color: color-mix(
          in oklab,
          var(--wa-color-fill-loud, var(--wa-color-neutral-fill-loud)),
          var(--wa-color-mix-hover)
        );
      }
    }
    .button:not(.disabled):not(.loading):active {
      background-color: color-mix(
        in oklab,
        var(--wa-color-fill-loud, var(--wa-color-neutral-fill-loud)),
        var(--wa-color-mix-active)
      );
    }
  }

  /* Focus states */
  .button:focus {
    outline: none;
  }

  .button:focus-visible {
    outline: var(--wa-focus-ring);
    outline-offset: var(--wa-focus-ring-offset);
  }

  /* Disabled state */
  :host([disabled]) {
    opacity: 0.5;
    cursor: not-allowed;

    /* When disabled, prevent mouse events from bubbling up from children */
    .button {
      pointer-events: none;
    }
  }

  /* Keep it last so Safari doesn't stop parsing this block */
  .button::-moz-focus-inner {
    border: 0;
  }

  /* Icon buttons */
  .button.is-icon-button {
    outline-offset: 2px;
    width: var(--wa-form-control-height);
    aspect-ratio: 1;
  }

  /* Icon buttons with a caret need to grow to fit both the icon and the caret */
  .button.is-icon-button.caret {
    width: auto;
    aspect-ratio: auto;
    min-width: var(--wa-form-control-height);
  }

  /* Pill modifier */
  :host([pill]) .button {
    border-start-start-radius: var(--_button-start-start-radius, var(--wa-border-radius-pill));
    border-start-end-radius: var(--_button-start-end-radius, var(--wa-border-radius-pill));
    border-end-start-radius: var(--_button-end-start-radius, var(--wa-border-radius-pill));
    border-end-end-radius: var(--_button-end-end-radius, var(--wa-border-radius-pill));
  }

  /*
   * Label
   */

  .start,
  .end {
    flex: 0 0 auto;
    display: flex;
    align-items: center;
    pointer-events: none;
  }

  .label {
    display: inline-block;
  }

  .is-icon-button .label {
    display: flex;
    justify-content: center;
  }

  .label::slotted(wa-icon) {
    align-self: center;
  }

  /*
   * Caret modifier
   */

  wa-icon[part='caret'] {
    display: flex;
    align-self: center;
    align-items: center;

    &::part(svg) {
      width: 0.875em;
      height: 0.875em;
    }

    .button:has(&) .end {
      display: none;
    }
  }

  /*
   * Loading modifier
   */

  .loading {
    position: relative;
    cursor: wait;

    .start,
    .label,
    .end,
    .caret {
      visibility: hidden;
    }

    wa-spinner {
      --indicator-color: currentColor;
      --track-color: color-mix(in oklab, currentColor, transparent 90%);

      position: absolute;
      font-size: 1em;
      height: 1em;
      width: 1em;
      top: calc(50% - 0.5em);
      left: calc(50% - 0.5em);
    }
  }

  /*
   * Badges
   */

  .button ::slotted(wa-badge) {
    border-color: var(--wa-color-surface-default);
    position: absolute;
    inset-block-start: 0;
    inset-inline-end: 0;
    translate: 50% -50%;
    pointer-events: none;
  }

  :host(:dir(rtl)) ::slotted(wa-badge) {
    translate: -50% -50%;
  }

  /*
  * Button spacing
  */

  slot[name='start']::slotted(*) {
    margin-inline-end: 0.75em;
  }

  slot[name='end']::slotted(*),
  .button:not(.visually-hidden-label) [part='caret'] {
    margin-inline-start: 0.75em;
  }
`,Za=Symbol.for(``),Qa=e=>{if(e?.r===Za)return e?._$litStatic$},$a=e=>{if(e._$litStatic$!==void 0)return e._$litStatic$;throw Error(`Value passed to 'literal' function must be a 'literal' result: ${e}. Use 'unsafeStatic' to pass non-literal values, but
            take care to ensure page security.`)},eo=(e,...t)=>({_$litStatic$:t.reduce((t,n,r)=>t+$a(n)+e[r+1],e[0]),r:Za}),to=new Map,no=(e=>(t,...n)=>{let r=n.length,i,a,o=[],s=[],c=0,l=!1,u;for(;c<r;){for(u=t[c];c<r&&(a=n[c],(i=Qa(a))!==void 0);)u+=i+t[++c],l=!0;c!==r&&s.push(a),o.push(u),c++}if(c===r&&o.push(t[r]),l){let e=o.join(`$$lit$$`);t=to.get(e),t===void 0&&(o.raw=o,to.set(e,t=o)),n=s}return e(t,...n)})(j),$=class extends H{constructor(){super(...arguments),this.assumeInteractionOn=[`click`],this.hasSlotController=new nr(this,`[default]`,`start`,`end`),this.localize=new vr(this),this.invalid=!1,this.isIconButton=!1,this.title=``,this.variant=`neutral`,this.appearance=`accent`,this.size=`m`,this.withCaret=!1,this.withStart=!1,this.withEnd=!1,this.disabled=!1,this.loading=!1,this.pill=!1,this.type=`button`}static get validators(){return[...super.validators,$n()]}handleSizeChange(){ar(this.localName,this.size)}constructLightDOMButton(){let e=document.createElement(`button`);for(let t of this.attributes)t.name!==`style`&&e.setAttribute(t.name,t.value);return e.type=this.type,e.style.position=`absolute !important`,e.style.width=`0 !important`,e.style.height=`0 !important`,e.style.clipPath=`inset(50%) !important`,e.style.overflow=`hidden !important`,e.style.whiteSpace=`nowrap !important`,this.name&&(e.name=this.name),e.value=this.value||``,e}handleClick(e){if(this.disabled||this.loading){e.preventDefault(),e.stopImmediatePropagation();return}if(this.type!==`submit`&&this.type!==`reset`||!this.getForm())return;let t=this.constructLightDOMButton();this.parentElement?.append(t),t.click(),t.remove()}handleInvalid(){this.dispatchEvent(new er)}handleLabelSlotChange(){let e=this.labelSlot.assignedNodes({flatten:!0}),t=!1,n=!1,r=!1,i=!1;[...e].forEach(e=>{if(e.nodeType===Node.ELEMENT_NODE){let r=e;r.localName===`wa-icon`?(n=!0,t||=r.label!==void 0):i=!0}else e.nodeType===Node.TEXT_NODE&&(e.textContent?.trim()||``).length>0&&(r=!0)}),this.isIconButton=n&&!r&&!i,this.customStates.set(`icon-button`,this.isIconButton),this.isIconButton&&!t&&console.warn(`Icon buttons must have a label for screen readers. Add <wa-icon label="..."> to remove this warning.`,this)}isButton(){return!this.href}isLink(){return!!this.href}handleDisabledChange(){this.customStates.set(`disabled`,this.disabled),this.updateValidity()}handleHrefChange(){this.customStates.set(`link`,this.isLink())}handleLoadingChange(){this.customStates.set(`loading`,this.loading)}setValue(...e){}click(){this.button.click()}focus(e){this.button.focus(e)}blur(){this.button.blur()}render(){let e=this.isLink(),t=e?eo`a`:eo`button`;return no`
      <${t}
        part="base button"
        class=${U({button:!0,caret:this.withCaret,disabled:this.disabled,loading:this.loading,rtl:this.localize.dir()===`rtl`,"has-label":this.hasSlotController.test(`[default]`),"has-start":this.hasSlotController.test(`start`,`withStart`),"has-end":this.hasSlotController.test(`end`,`withEnd`),"is-icon-button":this.isIconButton})}
        ?disabled=${W(e?void 0:this.disabled)}
        type=${W(e?void 0:this.type)}
        title=${this.title}
        name=${W(e?void 0:this.name)}
        value=${W(e?void 0:this.value)}
        href=${W(e?this.href:void 0)}
        target=${W(e?this.target:void 0)}
        download=${W(e?this.download:void 0)}
        rel=${W(e&&this.rel?this.rel:void 0)}
        role=${W(e?void 0:`button`)}
        aria-disabled=${W(e&&this.disabled?`true`:void 0)}
        tabindex=${this.disabled?`-1`:`0`}
        @invalid=${this.isButton()?this.handleInvalid:null}
        @click=${this.handleClick}
      >
        <slot name="start" part="start" class="start"></slot>
        <slot part="label" class="label" @slotchange=${this.handleLabelSlotChange}></slot>
        <slot name="end" part="end" class="end"></slot>
        ${this.withCaret?no`
                <wa-icon part="caret" class="caret" library="system" name="chevron-down" variant="solid"></wa-icon>
              `:``}
        ${this.loading?no`<wa-spinner part="spinner"></wa-spinner>`:``}
      </${t}>
    `}};$.shadowRootOptions={...H.shadowRootOptions,delegatesFocus:!0},$.css=[Xa,Pt,or],P([R(`.button`)],$.prototype,`button`,2),P([R(`slot:not([name])`)],$.prototype,`labelSlot`,2),P([L()],$.prototype,`invalid`,2),P([L()],$.prototype,`isIconButton`,2),P([I()],$.prototype,`title`,2),P([I({reflect:!0})],$.prototype,`variant`,2),P([I({reflect:!0})],$.prototype,`appearance`,2),P([I({reflect:!0})],$.prototype,`size`,2),P([B(`size`)],$.prototype,`handleSizeChange`,1),P([I({attribute:`with-caret`,type:Boolean,reflect:!0})],$.prototype,`withCaret`,2),P([I({attribute:`with-start`,type:Boolean})],$.prototype,`withStart`,2),P([I({attribute:`with-end`,type:Boolean})],$.prototype,`withEnd`,2),P([I({type:Boolean})],$.prototype,`disabled`,2),P([I({type:Boolean,reflect:!0})],$.prototype,`loading`,2),P([I({type:Boolean,reflect:!0})],$.prototype,`pill`,2),P([I()],$.prototype,`type`,2),P([I({reflect:!0})],$.prototype,`name`,2),P([I({reflect:!0})],$.prototype,`value`,2),P([I({reflect:!0})],$.prototype,`href`,2),P([I()],$.prototype,`target`,2),P([I()],$.prototype,`rel`,2),P([I()],$.prototype,`download`,2),P([I({attribute:`formaction`})],$.prototype,`formAction`,2),P([I({attribute:`formenctype`})],$.prototype,`formEnctype`,2),P([I({attribute:`formmethod`})],$.prototype,`formMethod`,2),P([I({attribute:`formnovalidate`,type:Boolean})],$.prototype,`formNoValidate`,2),P([I({attribute:`formtarget`})],$.prototype,`formTarget`,2),P([B(`disabled`,{waitUntilFirstUpdate:!0})],$.prototype,`handleDisabledChange`,1),P([B(`href`)],$.prototype,`handleHrefChange`,1),P([B(`loading`,{waitUntilFirstUpdate:!0})],$.prototype,`handleLoadingChange`,1),$=P([F(`wa-button`)],$),$.disableWarning?.(`change-in-update`),Nn(`default`,{resolver:e=>`/icons/${e}.svg`,mutator:e=>e.setAttribute(`fill`,`currentColor`)});function ro(e){}var io=`/Users/aaron.hans/dev/good-neighbor-app/frontend`,ao={"src/styles/buttons.stories.js":n,"src/styles/icons.stories.js":m,"src/styles/status-pills.stories.js":v,"src/styles/tokens.stories.js":tn,"src/styles/wa-form-controls.stories.js":cn},oo={"src/styles/buttons.stories.js":[`Default`,`Small`,`Disabled`,`Link`,`Loading`],"src/styles/icons.stories.js":[`Default`],"src/styles/status-pills.stories.js":[`Default`],"src/styles/tokens.stories.js":[`Tokens`],"src/styles/wa-form-controls.stories.js":[`Default`,`Otp`]},so={"src/styles/buttons.stories.js":{},"src/styles/icons.stories.js":{},"src/styles/status-pills.stories.js":{},"src/styles/tokens.stories.js":{},"src/styles/wa-form-controls.stories.js":{}},co=[fn,pn,mn],lo=[],uo=ro,fo=void 0,po={},mo={brand:{markHtml:`<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 7v14"/><path d="M3 18a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h5a4 4 0 0 1 4 4 4 4 0 0 1 4-4h5a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-6a3 3 0 0 0-3 3 3 3 0 0 0-3-3z"/></svg>`,titleHtml:`Good Neighbor UI`,subtitle:`Component workbench`},backgrounds:[{label:`Canvas`,value:`light-dark(#f7f7f7, #111111)`},{label:`White`,value:`#ffffff`},{label:`Dark`,value:`#111111`},{label:`Grid`,value:`linear-gradient(var(--storylite-grid-line-color) var(--storylite-grid-line-width), transparent var(--storylite-grid-line-width)) var(--storylite-grid-offset) var(--storylite-grid-offset) / var(--storylite-grid-major-size) var(--storylite-grid-major-size), linear-gradient(90deg, var(--storylite-grid-line-color) var(--storylite-grid-line-width), transparent var(--storylite-grid-line-width)) var(--storylite-grid-offset) var(--storylite-grid-offset) / var(--storylite-grid-major-size) var(--storylite-grid-major-size), linear-gradient(var(--storylite-grid-line-color-2) var(--storylite-grid-line-width), transparent var(--storylite-grid-line-width)) var(--storylite-grid-offset) var(--storylite-grid-offset) / var(--storylite-grid-size) var(--storylite-grid-size), linear-gradient(90deg, var(--storylite-grid-line-color-2) var(--storylite-grid-line-width), transparent var(--storylite-grid-line-width)) var(--storylite-grid-offset) var(--storylite-grid-offset) / var(--storylite-grid-size) var(--storylite-grid-size), linear-gradient(var(--storylite-grid-background-color), var(--storylite-grid-background-color))`}],viewports:[{label:`Phone`,width:`390px`,icon:`mobile`},{label:`Phone XL`,width:`430px`,icon:`mobile`},{label:`Fluid`,width:`100%`,icon:`fluid`},{label:`Mobile`,width:`390px`,icon:`mobile`},{label:`Tablet`,width:`768px`,icon:`tablet`},{label:`Desktop`,width:`1120px`,icon:`desktop`}],toolbar:[{id:`dark-mode`,label:`Dark mode (.wa-dark)`,icon:`moon`,type:`toggle`,defaultValue:!1,persist:!0,target:{type:`preview-class`,name:`wa-dark`}},{id:`a11y-outlines`,label:`Focus outlines on interactive elements`,icon:`accessibility`,type:`toggle`,defaultValue:!1,persist:!0,target:{type:`preview-class`,name:`show-a11y-outlines`}}],menuLinks:[{id:`github`,label:`GitHub`,href:`https://github.com/itsjavi/storylite`,icon:`globe`,target:`_blank`,rel:`noreferrer`}],css:``},ho={order:[`Foundations`,[`Tokens`,`Buttons`,`Status pills`],`Components`,`Web Awesome`]},go={htmlAttrs:{lang:`en`},bodyAttrs:{},headHtml:``,bodyStartHtml:``,bodyEndHtml:``},_o={htmlAttrs:{lang:`en`},bodyAttrs:{},headHtml:``,bodyStartHtml:``,bodyEndHtml:``},vo=null,yo=!0,bo=`./stories/`;export{co as globalCss,vo as home,lo as importedCss,yo as isStaticBuild,_o as managerHtml,go as previewHtml,io as projectRoot,mo as projectUi,po as rendererClientLoaders,uo as setupPreview,bo as staticStoriesBase,fo as storyIdResolver,oo as storyModuleExportNames,ao as storyModules,ho as storySort,so as storySourceMetadata};