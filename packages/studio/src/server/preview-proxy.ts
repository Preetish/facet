import { escapeHtmlAttr, safeJsonForScript } from "@facet/core";

export const DEFAULT_LIVE_PREVIEW_TIMEOUT_MS = 8_000;
export const DEFAULT_LIVE_PREVIEW_MAX_BYTES = 3 * 1024 * 1024; // 3 MB
export const DEFAULT_LIVE_PREVIEW_MAX_REDIRECTS = 3;

export interface LivePreviewProxyOptions {
  allowLocalTarget?: boolean;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  maxRedirects?: number;
}

export type TargetUrlValidationResult =
  { ok: true; url: URL } | { ok: false; status: 400 | 403; error: string };

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

const METADATA_HOSTNAMES = new Set(["metadata", "metadata.google.internal", "metadata.goog"]);

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "ip6-localhost",
  "ip6-loopback",
  ...METADATA_HOSTNAMES,
]);

function extractRawAuthorityHost(rawUrl: string): string | null {
  const match = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/.exec(rawUrl.trim());
  if (!match?.[1]) {
    return null;
  }
  const authority = match[1];
  const atIndex = authority.lastIndexOf("@");
  const hostPort = atIndex >= 0 ? authority.slice(atIndex + 1) : authority;
  if (hostPort.startsWith("[")) {
    const closeIdx = hostPort.indexOf("]");
    return closeIdx >= 0 ? hostPort.slice(1, closeIdx) : hostPort;
  }
  const colonIdx = hostPort.indexOf(":");
  return colonIdx >= 0 ? hostPort.slice(0, colonIdx) : hostPort;
}

function isNonStandardNumericIpv4(rawHost: string): boolean {
  const host = rawHost.toLowerCase().replace(/\.+$/, "");
  if (!host) {
    return false;
  }
  // Pure single integer (e.g. 2130706433) or hex integer (0x7f000001)
  if (/^\d+$/.test(host) || /^0x[0-9a-f]+$/.test(host)) {
    return true;
  }
  // Dotted numeric literal (2, 3, or 4 parts) with non-standard decimal/octal/hex parts
  const parts = host.split(".");
  if (parts.length >= 2 && parts.length <= 4) {
    const allNumericLike = parts.every((p) => /^(?:0x[0-9a-f]+|\d+)$/.test(p));
    if (allNumericLike) {
      if (parts.length !== 4) {
        return true;
      }
      // Octal (leading zero on multi-digit) or hex in any octet
      if (parts.some((p) => /^0x/.test(p) || (p.length > 1 && p.startsWith("0")))) {
        return true;
      }
    }
  }
  return false;
}

function parseDottedIpv4(host: string): [number, number, number, number] | null {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return null;
  }
  const octets: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) {
      return null;
    }
    octets.push(n);
  }
  return [octets[0]!, octets[1]!, octets[2]!, octets[3]!];
}

function isBlockedIpv4(octets: [number, number, number, number]): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this" network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC 1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC 1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC 1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmarking)
  if (a >= 224) return true; // multicast & reserved (224.0.0.0/4, 240.0.0.0/4)
  return false;
}

function parseIpv6Groups(raw: string): number[] | null {
  const addr = raw.toLowerCase();
  // Reject zone identifiers
  if (addr.includes("%")) {
    return null;
  }

  // Handle embedded IPv4 suffix (e.g. ::ffff:127.0.0.1)
  let normalized = addr;
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon >= 0 && normalized.slice(lastColon + 1).includes(".")) {
    const ipv4 = parseDottedIpv4(normalized.slice(lastColon + 1));
    if (!ipv4) {
      return null;
    }
    const hi = ((ipv4[0] << 8) | ipv4[1]).toString(16);
    const lo = ((ipv4[2] << 8) | ipv4[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) {
    return null;
  }

  const parseSegment = (segment: string): number[] | null => {
    if (segment === "") {
      return [];
    }
    const parts = segment.split(":");
    const nums: number[] = [];
    for (const part of parts) {
      if (!/^[0-9a-f]{1,4}$/.test(part)) {
        return null;
      }
      nums.push(parseInt(part, 16));
    }
    return nums;
  };

  if (doubleColonParts.length === 1) {
    const groups = parseSegment(doubleColonParts[0]!);
    return groups && groups.length === 8 ? groups : null;
  }

  const left = parseSegment(doubleColonParts[0]!);
  const right = parseSegment(doubleColonParts[1]!);
  if (!left || !right) {
    return null;
  }
  const missing = 8 - (left.length + right.length);
  if (missing < 1) {
    return null;
  }
  return [...left, ...new Array<number>(missing).fill(0), ...right];
}

function isBlockedIpv6(host: string): boolean {
  const groups = parseIpv6Groups(host);
  if (!groups) {
    return true;
  }
  const g0 = groups[0]!;
  const g1 = groups[1]!;
  const g5 = groups[5]!;
  const g7 = groups[7]!;

  const firstFiveZero =
    groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0;

  // Unspecified :: and loopback ::1 and IPv4-compatible ::/96
  if (firstFiveZero && g5 === 0) {
    return true;
  }
  // Any IPv4-mapped IPv6 address (::ffff:0:0/96)
  if (firstFiveZero && g5 === 0xffff) {
    return true;
  }
  // NAT64 well-known & local-use prefixes (64:ff9b::/96, 64:ff9b:1::/48)
  if (g0 === 0x0064 && g1 === 0xff9b) {
    return true;
  }
  // Unique Local Addresses fc00::/7 (fc00..fdff)
  if ((g0 & 0xfe00) === 0xfc00) {
    return true;
  }
  // Link-Local fe80::/10 (fe80..febf)
  if ((g0 & 0xffc0) === 0xfe80) {
    return true;
  }
  // Deprecated Site-Local fec0::/10
  if ((g0 & 0xffc0) === 0xfec0) {
    return true;
  }
  // Multicast ff00::/8
  if ((g0 & 0xff00) === 0xff00) {
    return true;
  }
  // Discard prefix 0100::/64
  if (g0 === 0x0100 && g1 === 0 && groups[2] === 0 && groups[3] === 0) {
    return true;
  }
  // Loopback fallback check
  if (firstFiveZero && g5 === 0 && groups[6] === 0 && g7 === 1) {
    return true;
  }

  return false;
}

function isCloudMetadataOrLinkLocal(normalizedHost: string): boolean {
  if (METADATA_HOSTNAMES.has(normalizedHost)) {
    return true;
  }
  if (normalizedHost.includes(":")) {
    const groups = parseIpv6Groups(normalizedHost);
    if (!groups) {
      return true;
    }
    const firstFiveZero =
      groups[0] === 0 && groups[1] === 0 && groups[2] === 0 && groups[3] === 0 && groups[4] === 0;
    if (firstFiveZero && (groups[5] === 0xffff || groups[5] === 0)) {
      const hi = groups[6]!;
      if (((hi >> 8) & 0xff) === 169 && (hi & 0xff) === 254) {
        return true;
      }
    }
    if ((groups[0]! & 0xffc0) === 0xfe80) {
      return true;
    }
    return false;
  }
  const ipv4 = parseDottedIpv4(normalizedHost);
  if (ipv4 && ipv4[0] === 169 && ipv4[1] === 254) {
    return true;
  }
  return false;
}

export function validatePreviewTargetUrl(
  rawUrl: string,
  allowLocalTarget = false,
): TargetUrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { ok: false, status: 400, error: "A valid http:// or https:// target URL is required" };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { ok: false, status: 400, error: "Invalid target URL" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      ok: false,
      status: 400,
      error: `Unsupported URL protocol "${parsed.protocol}". Only http: and https: are allowed.`,
    };
  }

  if (parsed.username || parsed.password) {
    return {
      ok: false,
      status: 400,
      error: "Embedded URL credentials are not allowed in live preview targets",
    };
  }

  const normalizedHost = parsed.hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "");

  if (!normalizedHost) {
    return { ok: false, status: 400, error: "Target URL must include a valid hostname" };
  }

  // Always block cloud metadata & link-local endpoints even when allowLocalTarget is true
  if (isCloudMetadataOrLinkLocal(normalizedHost)) {
    return {
      ok: false,
      status: 403,
      error: `Target "${normalizedHost}" is blocked by live preview cloud metadata protection`,
    };
  }

  if (allowLocalTarget) {
    return { ok: true, url: parsed };
  }

  // Block raw numeric / octal / hex IPv4 forms before/beyond URL normalization
  const rawHost = extractRawAuthorityHost(trimmed);
  if (rawHost && isNonStandardNumericIpv4(rawHost)) {
    return {
      ok: false,
      status: 403,
      error: "Numeric IPv4 targets are blocked by live preview SSRF protection",
    };
  }

  if (
    BLOCKED_HOSTNAMES.has(normalizedHost) ||
    normalizedHost.endsWith(".localhost") ||
    normalizedHost.endsWith(".local") ||
    normalizedHost.endsWith(".internal")
  ) {
    return {
      ok: false,
      status: 403,
      error: `Target host "${normalizedHost}" is blocked by live preview SSRF protection`,
    };
  }

  if (normalizedHost.includes(":")) {
    if (isBlockedIpv6(normalizedHost)) {
      return {
        ok: false,
        status: 403,
        error: `Target IPv6 address "${normalizedHost}" is blocked by live preview SSRF protection`,
      };
    }
    return { ok: true, url: parsed };
  }

  const ipv4 = parseDottedIpv4(normalizedHost);
  if (ipv4 && isBlockedIpv4(ipv4)) {
    return {
      ok: false,
      status: 403,
      error: `Target IP address "${normalizedHost}" is blocked by live preview SSRF protection`,
    };
  }

  return { ok: true, url: parsed };
}

function stripSecurityMetaTags(html: string): string {
  return html.replace(/<meta\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi, (tag) => {
    if (
      /\bhttp-equiv\s*=\s*(?:"(?:content-security-policy(?:-report-only)?|x-frame-options)"|'(?:content-security-policy(?:-report-only)?|x-frame-options)'|(?:content-security-policy(?:-report-only)?|x-frame-options)(?=[\s/>]))/i.test(
        tag,
      )
    ) {
      return "";
    }
    return tag;
  });
}

function injectAfterHead(html: string, snippet: string): string {
  const headMatch = /<head(?:\s[^>]*)?>/i.exec(html);
  if (headMatch && headMatch.index !== undefined) {
    const insertAt = headMatch.index + headMatch[0].length;
    return `${html.slice(0, insertAt)}${snippet}${html.slice(insertAt)}`;
  }
  const doctypeMatch = /^(\s*<!doctype[^>]*>\s*)/i.exec(html);
  if (doctypeMatch) {
    const insertAt = doctypeMatch[0].length;
    return `${html.slice(0, insertAt)}${snippet}${html.slice(insertAt)}`;
  }
  return `${snippet}${html}`;
}

function injectBeforeBodyClose(html: string, snippet: string): string {
  const bodyMatches = Array.from(html.matchAll(/<\/body\s*>/gi));
  const lastBody = bodyMatches.at(-1);
  if (lastBody && lastBody.index !== undefined) {
    return `${html.slice(0, lastBody.index)}${snippet}${html.slice(lastBody.index)}`;
  }
  const htmlMatches = Array.from(html.matchAll(/<\/html\s*>/gi));
  const lastHtml = htmlMatches.at(-1);
  if (lastHtml && lastHtml.index !== undefined) {
    return `${html.slice(0, lastHtml.index)}${snippet}${html.slice(lastHtml.index)}`;
  }
  return `${html}${snippet}`;
}

export function buildPreviewBridgeScript(finalUrl: string): string {
  const serializedUrl = safeJsonForScript(finalUrl);

  return `<script data-facet-studio-ui="true">(function(){
"use strict";
var FINAL_URL=${serializedUrl};
var ORIGIN=(window.location&&window.location.origin&&window.location.origin!=="null")?window.location.origin:"*";
var snapshots=new Map();
var pickEnabled=false;
var hoveredEl=null;
var hoverBox=null;
var hoverPill=null;
var cursorStyle=null;

function postToParent(msg){
  if(!window.parent||window.parent===window)return;
  try{window.parent.postMessage(msg,ORIGIN);}catch(_e){}
}

function isStudioUiNode(el){
  if(!el||el.nodeType!==1)return true;
  if(el.hasAttribute&&el.hasAttribute("data-facet-studio-ui"))return true;
  return Boolean(el.closest&&el.closest("[data-facet-studio-ui]"));
}

function captureSnapshot(el){
  if(snapshots.has(el))return;
  var attrs=[];
  if(el.attributes){
    for(var i=0;i<el.attributes.length;i++){
      attrs.push([el.attributes[i].name,el.attributes[i].value]);
    }
  }
  snapshots.set(el,{
    textContent:el.textContent,
    innerHTML:el.innerHTML,
    attrs:attrs,
    className:el.getAttribute("class"),
    display:el.style?el.style.display:"",
    outline:el.style?el.style.outline:"",
    outlineOffset:el.style?el.style.outlineOffset:""
  });
}

function restoreAll(){
  snapshots.forEach(function(snap,el){
    if(!el||el.nodeType!==1)return;
    var origNames=new Set();
    for(var i=0;i<snap.attrs.length;i++){
      origNames.add(snap.attrs[i][0]);
    }
    if(el.attributes){
      var currentNames=[];
      for(var j=0;j<el.attributes.length;j++){
        currentNames.push(el.attributes[j].name);
      }
      for(var k=0;k<currentNames.length;k++){
        if(!origNames.has(currentNames[k])){
          try{el.removeAttribute(currentNames[k]);}catch(_e){}
        }
      }
    }
    for(var m=0;m<snap.attrs.length;m++){
      try{el.setAttribute(snap.attrs[m][0],snap.attrs[m][1]);}catch(_e){}
    }
    if(snap.className===null){
      try{el.removeAttribute("class");}catch(_e){}
    }
    if(el.style){
      el.style.display=snap.display;
      el.style.outline=snap.outline;
      el.style.outlineOffset=snap.outlineOffset;
    }
    try{el.innerHTML=snap.innerHTML;}catch(_e){
      try{el.textContent=snap.textContent;}catch(_e2){}
    }
  });
  snapshots.clear();
}

function normalizeClasses(val){
  if(!val)return [];
  var list=Array.isArray(val)?val:[val];
  var out=[];
  for(var i=0;i<list.length;i++){
    if(typeof list[i]!=="string")continue;
    var parts=list[i].split(/\\s+/);
    for(var j=0;j<parts.length;j++){
      var t=parts[j].trim();
      if(t)out.push(t);
    }
  }
  return out;
}

function applyChanges(changes,highlight){
  restoreAll();
  var list=Array.isArray(changes)?changes:[];
  var matchedCount=0;
  var missingSelectors=[];
  var shouldHighlight=highlight!==false;

  for(var i=0;i<list.length;i++){
    var ch=list[i];
    if(!ch||typeof ch.selector!=="string"||!ch.selector.trim()){
      continue;
    }
    var matched=[];
    try{
      var found=document.querySelectorAll(ch.selector);
      for(var n=0;n<found.length;n++){
        if(!isStudioUiNode(found[n])){
          matched.push(found[n]);
        }
      }
    }catch(_e){
      missingSelectors.push(ch.selector);
      continue;
    }

    if(matched.length===0){
      missingSelectors.push(ch.selector);
      continue;
    }

    matchedCount+=1;

    for(var m=0;m<matched.length;m++){
      var el=matched[m];
      captureSnapshot(el);

      if(ch.remove===true){
        if(el.style)el.style.display="none";
        continue;
      }

      if(typeof ch.text==="string"){
        el.textContent=ch.text;
      }else if(typeof ch.html==="string"){
        el.innerHTML=ch.html;
      }

      if(typeof ch.prepend==="string"){
        try{el.insertAdjacentHTML("afterbegin",ch.prepend);}catch(_e){}
      }
      if(typeof ch.append==="string"){
        try{el.insertAdjacentHTML("beforeend",ch.append);}catch(_e){}
      }

      if(ch.attrs&&typeof ch.attrs==="object"){
        var attrKeys=Object.keys(ch.attrs);
        for(var a=0;a<attrKeys.length;a++){
          var key=attrKeys[a];
          var lowerKey=key.toLowerCase();
          if(/^on/.test(lowerKey))continue;
          var val=ch.attrs[key];
          if(val===null){
            try{el.removeAttribute(key);}catch(_e){}
          }else if(typeof val==="string"){
            if((lowerKey==="href"||lowerKey==="src"||lowerKey==="action"||lowerKey==="formaction"||lowerKey==="xlink:href")&&/^\\s*(?:javascript:|vbscript:|data:\\s*text\\/html)/i.test(val))continue;
            try{el.setAttribute(key,val);}catch(_e){}
          }
        }
      }

      var toAdd=normalizeClasses(ch.addClass);
      for(var c1=0;c1<toAdd.length;c1++){
        try{el.classList.add(toAdd[c1]);}catch(_e){}
      }
      var toRemove=normalizeClasses(ch.removeClass);
      for(var c2=0;c2<toRemove.length;c2++){
        try{el.classList.remove(toRemove[c2]);}catch(_e){}
      }

      if(shouldHighlight&&el.style){
        el.style.outline="2px dashed #116b4b";
        el.style.outlineOffset="3px";
      }
    }
  }

  postToParent({
    type:"facet:applied",
    matchedCount:matchedCount,
    totalCount:list.length,
    missingSelectors:missingSelectors
  });
}

function cssEscape(value){
  if(window.CSS&&typeof window.CSS.escape==="function"){
    return window.CSS.escape(value);
  }
  return String(value).replace(/([!"#$%&'()*+,.\\/:;<=>?@[\\\\\\]^\`{|}~])/g,"\\\\$1");
}

function attrQuote(value){
  return JSON.stringify(String(value));
}

function isUniqueSelector(sel,target){
  try{
    var list=document.querySelectorAll(sel);
    return list.length===1&&list[0]===target;
  }catch(_e){
    return false;
  }
}

function isVolatileClass(cls){
  if(!cls||cls.length>48)return true;
  if(/^(hover:|focus:|active:|sm:|md:|lg:|xl:|2xl:|dark:|group-)/.test(cls))return true;
  if(cls.indexOf("[")>=0||cls.indexOf("]")>=0||cls.indexOf("(")>=0)return true;
  if(/^__(?:className|variable)_/.test(cls))return true;
  if(/^[A-Z][A-Za-z0-9]+_[A-Za-z0-9-]+__[A-Za-z0-9_-]{4,}$/.test(cls))return true;
  var dunderIdx=cls.lastIndexOf("__");
  if(dunderIdx>0){
    var suffix=cls.slice(dunderIdx+2);
    if(suffix.length>=5&&(/[0-9]/.test(suffix)||(/[a-z]/.test(suffix)&&/[A-Z]/.test(suffix)))){
      return true;
    }
  }
  if(/^(?:css|sc|jsx|svelte|astro|emotion|styled)-[A-Za-z0-9_-]{4,}$/.test(cls))return true;
  if(/_(?=.*[0-9])(?=.*[A-Za-z])[A-Za-z0-9]{5,}$/.test(cls))return true;
  return false;
}

function isVolatileId(id){
  if(!id)return true;
  if(/(?:^|:)r[0-9a-z]+:$/i.test(id))return true;
  return false;
}

function nearestLandmarkPrefix(el){
  var cur=el.parentElement;
  while(cur&&cur.nodeType===1&&cur!==document.body){
    var t=cur.tagName.toLowerCase();
    if(t==="header"||t==="nav"||t==="main"||t==="footer"||t==="aside"){
      return t;
    }
    var slot=cur.getAttribute("data-facet-slot");
    if(slot)return "[data-facet-slot="+attrQuote(slot)+"]";
    if(cur.id&&!isVolatileId(cur.id))return "#"+cssEscape(cur.id);
    cur=cur.parentElement;
  }
  return "";
}

function tryWithLandmark(baseSel,el,landmark){
  if(isUniqueSelector(baseSel,el))return baseSel;
  if(landmark){
    var scoped=landmark+" "+baseSel;
    if(isUniqueSelector(scoped,el))return scoped;
  }
  return "";
}

function computeUniqueSelector(el){
  if(!el||el.nodeType!==1)return "";

  var facetSlot=el.getAttribute("data-facet-slot");
  if(facetSlot){
    var slotSel="[data-facet-slot="+attrQuote(facetSlot)+"]";
    if(isUniqueSelector(slotSel,el))return slotSel;
  }

  var cta=el.getAttribute("data-cta");
  if(cta){
    var ctaSel="[data-cta="+attrQuote(cta)+"]";
    if(isUniqueSelector(ctaSel,el))return ctaSel;
  }

  if(el.id&&!isVolatileId(el.id)){
    var idSel="#"+cssEscape(el.id);
    if(isUniqueSelector(idSel,el))return idSel;
  }

  var tag=el.tagName.toLowerCase();
  if(tag==="h1"&&isUniqueSelector("h1",el)){
    return "h1";
  }

  var testId=el.getAttribute("data-testid");
  if(testId){
    var testSel="[data-testid="+attrQuote(testId)+"]";
    if(isUniqueSelector(testSel,el))return testSel;
  }

  var landmark=nearestLandmarkPrefix(el);

  if(el.classList&&el.classList.length>0){
    var classes=[];
    for(var i=0;i<el.classList.length;i++){
      var cls=el.classList[i];
      if(!isVolatileClass(cls)){
        classes.push(cls);
      }
    }
    for(var j=0;j<classes.length;j++){
      var singleMatch=tryWithLandmark(tag+"."+cssEscape(classes[j]),el,landmark);
      if(singleMatch)return singleMatch;
    }
    if(classes.length>=2){
      var pairMatch=tryWithLandmark(tag+"."+cssEscape(classes[0])+"."+cssEscape(classes[1]),el,landmark);
      if(pairMatch)return pairMatch;
    }
  }

  var ariaLabel=el.getAttribute("aria-label");
  if(ariaLabel&&ariaLabel.length<=80){
    var ariaMatch=tryWithLandmark(tag+"[aria-label="+attrQuote(ariaLabel)+"]",el,landmark);
    if(ariaMatch)return ariaMatch;
  }

  if(tag==="a"){
    var hrefVal=el.getAttribute("href");
    if(hrefVal&&hrefVal.length<=160&&!/^\\s*javascript:/i.test(hrefVal)){
      var hrefMatch=tryWithLandmark("a[href="+attrQuote(hrefVal)+"]",el,landmark);
      if(hrefMatch)return hrefMatch;
    }
  }

  if(tag==="button"||tag==="input"||tag==="select"||tag==="textarea"){
    var nameVal=el.getAttribute("name");
    if(nameVal&&nameVal.length<=80){
      var nameMatch=tryWithLandmark(tag+"[name="+attrQuote(nameVal)+"]",el,landmark);
      if(nameMatch)return nameMatch;
    }
  }

  var parts=[];
  var cur=el;
  while(cur&&cur.nodeType===1&&cur!==document.documentElement){
    var cTag=cur.tagName.toLowerCase();
    if(cTag==="body"){
      parts.unshift("body");
      break;
    }
    var cSlot=cur.getAttribute("data-facet-slot");
    if(cSlot){
      parts.unshift("[data-facet-slot="+attrQuote(cSlot)+"]");
      if(isUniqueSelector(parts.join(" > "),el))return parts.join(" > ");
    }else if(cur.id&&!isVolatileId(cur.id)){
      parts.unshift("#"+cssEscape(cur.id));
      if(isUniqueSelector(parts.join(" > "),el))return parts.join(" > ");
    }else{
      var seg=cTag;
      var parent=cur.parentElement;
      if(parent){
        var sameTag=0;
        var index=0;
        for(var s=0;s<parent.children.length;s++){
          var sib=parent.children[s];
          if(sib.tagName===cur.tagName){
            sameTag+=1;
            if(sib===cur)index=sameTag;
          }
        }
        if(sameTag>1){
          seg+=":nth-of-type("+index+")";
        }
      }
      parts.unshift(seg);
      var candidate=parts.join(" > ");
      if(isUniqueSelector(candidate,el))return candidate;
    }
    cur=cur.parentElement;
  }

  return parts.join(" > ")||tag;
}

function resolvePickTarget(rawTarget){
  if(!rawTarget||rawTarget.nodeType!==1)return null;
  if(rawTarget===document.documentElement||rawTarget===document.body)return null;
  if(isStudioUiNode(rawTarget))return null;
  var el=rawTarget;
  if(el.matches&&el.matches("svg,path,g,circle,rect,line,polygon,polyline")){
    var interactive=el.closest("a,button");
    if(interactive&&!isStudioUiNode(interactive))return interactive;
  }
  if(el.tagName==="SPAN"&&el.parentElement&&(el.parentElement.tagName==="A"||el.parentElement.tagName==="BUTTON")){
    return el.parentElement;
  }
  return el;
}

function friendlyLabel(el){
  var tag=el.tagName.toLowerCase();
  var slot=el.getAttribute("data-facet-slot");
  if(slot)return tag+" [data-facet-slot="+slot+"]";
  var cta=el.getAttribute("data-cta");
  if(cta)return tag+" [data-cta="+cta+"]";
  if(el.id&&!isVolatileId(el.id))return tag+"#"+el.id;
  if(el.classList&&el.classList.length>0){
    for(var i=0;i<el.classList.length;i++){
      if(!isVolatileClass(el.classList[i])){
        return tag+"."+el.classList[i];
      }
    }
  }
  var aria=el.getAttribute("aria-label");
  if(aria)return tag+" ("+aria.slice(0,28)+")";
  return tag;
}

function ensureOverlay(){
  if(!hoverBox){
    hoverBox=document.createElement("div");
    hoverBox.setAttribute("data-facet-studio-ui","true");
    hoverBox.style.cssText="position:fixed;pointer-events:none;z-index:2147483646;border:2px solid #116b4b;background:rgba(17,107,75,0.08);border-radius:3px;box-sizing:border-box;display:none;";
    document.documentElement.appendChild(hoverBox);
  }
  if(!hoverPill){
    hoverPill=document.createElement("div");
    hoverPill.setAttribute("data-facet-studio-ui","true");
    hoverPill.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;background:#116b4b;color:#ffffff;font:600 12px/1.2 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:3px 8px;border-radius:4px;white-space:nowrap;max-width:320px;overflow:hidden;text-overflow:ellipsis;display:none;";
    document.documentElement.appendChild(hoverPill);
  }
  if(!cursorStyle){
    cursorStyle=document.createElement("style");
    cursorStyle.setAttribute("data-facet-studio-ui","true");
    cursorStyle.textContent="html,body,body *{cursor:crosshair!important;}";
    (document.head||document.documentElement).appendChild(cursorStyle);
  }
}

function updateOverlayFor(el){
  if(!hoverBox||!hoverPill)return;
  if(!el||!el.getBoundingClientRect){
    hoverBox.style.display="none";
    hoverPill.style.display="none";
    return;
  }
  var r=el.getBoundingClientRect();
  if(r.width<=0&&r.height<=0){
    hoverBox.style.display="none";
    hoverPill.style.display="none";
    return;
  }
  hoverBox.style.display="block";
  hoverBox.style.left=r.left+"px";
  hoverBox.style.top=r.top+"px";
  hoverBox.style.width=r.width+"px";
  hoverBox.style.height=r.height+"px";

  hoverPill.textContent=friendlyLabel(el);
  hoverPill.style.display="block";
  var pillTop=r.top>=28?r.top-26:Math.max(4,r.top+4);
  var pillLeft=Math.max(4,Math.min(r.left,window.innerWidth-160));
  hoverPill.style.top=pillTop+"px";
  hoverPill.style.left=pillLeft+"px";
}

function onPickMove(e){
  if(!pickEnabled)return;
  var target=resolvePickTarget(e.target);
  if(!target||target===document.documentElement||target===document.body){
    hoveredEl=null;
    updateOverlayFor(null);
    return;
  }
  hoveredEl=target;
  updateOverlayFor(target);
}

function onPickScroll(){
  if(pickEnabled&&hoveredEl){
    updateOverlayFor(hoveredEl);
  }
}

function onPickClick(e){
  if(!pickEnabled)return;
  e.preventDefault();
  e.stopPropagation();
  if(typeof e.stopImmediatePropagation==="function")e.stopImmediatePropagation();

  var target=resolvePickTarget(e.target)||hoveredEl;
  if(!target)return;

  var selector=computeUniqueSelector(target);
  var tagName=target.tagName.toLowerCase();
  var rawText=typeof target.innerText==="string"&&target.innerText.trim()?target.innerText:(target.textContent||"");
  var text=rawText.trim().replace(/\\s+/g," ").slice(0,240);
  var href=target.getAttribute("href");

  setPickMode(false);
  postToParent({
    type:"facet:picked",
    selector:selector,
    tagName:tagName,
    text:text,
    href:href!==null?href:null
  });
}

function onPickKeydown(e){
  if(!pickEnabled)return;
  if(e.key==="Escape"){
    e.preventDefault();
    e.stopPropagation();
    setPickMode(false);
    postToParent({type:"facet:pick-cancelled"});
  }
}

function setPickMode(enabled){
  var next=Boolean(enabled);
  if(next===pickEnabled)return;
  pickEnabled=next;

  if(pickEnabled){
    ensureOverlay();
    document.addEventListener("mousemove",onPickMove,true);
    document.addEventListener("mouseover",onPickMove,true);
    document.addEventListener("click",onPickClick,true);
    document.addEventListener("keydown",onPickKeydown,true);
    window.addEventListener("scroll",onPickScroll,true);
  }else{
    hoveredEl=null;
    document.removeEventListener("mousemove",onPickMove,true);
    document.removeEventListener("mouseover",onPickMove,true);
    document.removeEventListener("click",onPickClick,true);
    document.removeEventListener("keydown",onPickKeydown,true);
    window.removeEventListener("scroll",onPickScroll,true);
    if(hoverBox)hoverBox.style.display="none";
    if(hoverPill)hoverPill.style.display="none";
    if(cursorStyle&&cursorStyle.parentNode){
      cursorStyle.parentNode.removeChild(cursorStyle);
      cursorStyle=null;
    }
  }
}

window.addEventListener("message",function(event){
  if(event.source!==window.parent)return;
  if(ORIGIN!=="*"&&event.origin!==ORIGIN)return;
  var data=event.data;
  if(!data||typeof data!=="object")return;
  if(data.type==="facet:apply"){
    applyChanges(data.changes,data.highlight);
  }else if(data.type==="facet:pick-mode"){
    setPickMode(Boolean(data.enabled));
  }
});

function sendReady(){
  postToParent({
    type:"facet:ready",
    url:FINAL_URL,
    title:document.title||""
  });
}

if(document.readyState==="loading"){
  document.addEventListener("DOMContentLoaded",sendReady,{once:true});
}else{
  sendReady();
}
})();</script>`;
}

function stripUpstreamScripts(html: string): string {
  // Remove upstream executable <script> tags and script preload hints so target-site SPA
  // hydration (e.g. Next.js / Remix / Vite routers), analytics tags, and cookie banners
  // never throw client-side exceptions or overwrite Studio preview DOM edits.
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, "")
    .replace(
      /<link\b[^>]*\brel\s*=\s*(?:"modulepreload"|'modulepreload'|modulepreload)[^>]*>/gi,
      "",
    )
    .replace(
      /<link\b[^>]*\brel\s*=\s*(?:"preload"|'preload'|preload)[^>]*\bas\s*=\s*(?:"script"|'script'|script)[^>]*>/gi,
      "",
    )
    .replace(
      /<link\b[^>]*\bas\s*=\s*(?:"script"|'script'|script)[^>]*\brel\s*=\s*(?:"preload"|'preload'|preload)[^>]*>/gi,
      "",
    );
}

export function rewriteHtmlForPreview(html: string, finalUrl: string): string {
  const baseHref = new URL("./", finalUrl).toString();
  const baseTag = `<base href="${escapeHtmlAttr(baseHref)}" target="_blank">`;
  const bridgeScript = buildPreviewBridgeScript(finalUrl);

  const withoutCsp = stripSecurityMetaTags(html);
  const withoutScripts = stripUpstreamScripts(withoutCsp);
  const withBase = injectAfterHead(withoutScripts, baseTag);
  return injectBeforeBodyClose(withBase, bridgeScript);
}

function errorJson(error: string, status: number): Response {
  return new Response(JSON.stringify({ ok: false, error }), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "X-Frame-Options": "DENY",
      "Referrer-Policy": "same-origin",
    },
  });
}

async function readResponseTextWithLimit(
  response: Response,
  maxBytes: number,
): Promise<{ ok: true; text: string } | { ok: false; status: 413; error: string }> {
  const contentLengthHeader = response.headers.get("content-length");
  if (contentLengthHeader) {
    const declared = Number(contentLengthHeader);
    if (Number.isFinite(declared) && declared > maxBytes) {
      await response.body?.cancel();
      return {
        ok: false,
        status: 413,
        error: `Target HTML document exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit`,
      };
    }
  }

  if (!response.body) {
    const buf = new Uint8Array(await response.arrayBuffer());
    if (buf.byteLength > maxBytes) {
      return {
        ok: false,
        status: 413,
        error: `Target HTML document exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit`,
      };
    }
    return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(buf) };
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          return {
            ok: false,
            status: 413,
            error: `Target HTML document exceeds the ${Math.round(maxBytes / (1024 * 1024))} MB preview limit`,
          };
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return { ok: true, text: new TextDecoder("utf-8", { fatal: false }).decode(combined) };
}

export async function handleLivePreviewRequest(
  rawUrl: string,
  options: LivePreviewProxyOptions = {},
): Promise<Response> {
  const allowLocalTarget = options.allowLocalTarget === true;
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_LIVE_PREVIEW_TIMEOUT_MS;
  const maxBytes = options.maxBytes ?? DEFAULT_LIVE_PREVIEW_MAX_BYTES;
  const maxRedirects = options.maxRedirects ?? DEFAULT_LIVE_PREVIEW_MAX_REDIRECTS;

  const initialCheck = validatePreviewTargetUrl(rawUrl, allowLocalTarget);
  if (!initialCheck.ok) {
    return errorJson(initialCheck.error, initialCheck.status);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    let currentUrl = initialCheck.url.toString();
    let upstream: Response | null = null;

    for (let hop = 0; hop <= maxRedirects; hop++) {
      let res: Response;
      try {
        res = await fetchFn(currentUrl, {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: {
            Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8",
            "User-Agent": "FacetStudioPreview/1.0",
          },
        });
      } catch (err) {
        if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
          return errorJson(`Timed out fetching target site after ${timeoutMs}ms`, 504);
        }
        return errorJson(
          err instanceof Error
            ? `Unable to reach target site: ${err.message}`
            : "Unable to reach target site",
          502,
        );
      }

      if (REDIRECT_STATUSES.has(res.status)) {
        const location = res.headers.get("location");
        await res.body?.cancel();
        if (!location) {
          return errorJson("Upstream redirect response missing Location header", 502);
        }
        if (hop === maxRedirects) {
          return errorJson(`Target URL exceeded maximum redirect limit (${maxRedirects})`, 502);
        }
        let resolvedRedirect: string;
        try {
          resolvedRedirect = new URL(location, currentUrl).toString();
        } catch {
          return errorJson("Upstream returned an invalid redirect URL", 502);
        }
        const redirectCheck = validatePreviewTargetUrl(resolvedRedirect, allowLocalTarget);
        if (!redirectCheck.ok) {
          return errorJson(redirectCheck.error, redirectCheck.status);
        }
        currentUrl = redirectCheck.url.toString();
        continue;
      }

      upstream = res;
      break;
    }

    if (!upstream) {
      return errorJson("Failed to resolve target preview response", 502);
    }

    if (!upstream.ok) {
      await upstream.body?.cancel();
      return errorJson(`Target site returned HTTP ${upstream.status}`, 502);
    }

    const rawContentType = upstream.headers.get("content-type") ?? "";
    const mimeType = rawContentType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
    if (mimeType !== "text/html" && mimeType !== "application/xhtml+xml") {
      await upstream.body?.cancel();
      return errorJson(
        `Target URL returned unsupported content type "${mimeType || "unknown"}"; expected text/html`,
        415,
      );
    }

    let bodyResult: { ok: true; text: string } | { ok: false; status: 413; error: string };
    try {
      bodyResult = await readResponseTextWithLimit(upstream, maxBytes);
    } catch (err) {
      if (controller.signal.aborted || (err instanceof Error && err.name === "AbortError")) {
        return errorJson(`Timed out reading target site after ${timeoutMs}ms`, 504);
      }
      return errorJson("Failed to read target HTML response", 502);
    }

    if (!bodyResult.ok) {
      return errorJson(bodyResult.error, bodyResult.status);
    }

    const rewrittenHtml = rewriteHtmlForPreview(bodyResult.text, currentUrl);

    return new Response(rewrittenHtml, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
        "X-Frame-Options": "SAMEORIGIN",
        "Referrer-Policy": "no-referrer",
      },
    });
  } finally {
    clearTimeout(timer);
  }
}
