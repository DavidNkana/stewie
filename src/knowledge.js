const fs = require('node:fs');
const path = require('node:path');

/**
 * Server-side business knowledge.
 *
 * This is configuration, not prompt input: a client message can never change
 * what is in here. Prices, contact details and the founder are read from
 * this file and injected into the prompt as approved public facts.
 */
function loadKnowledge(file = 'knowledge/safai.json') {
  const resolved = path.resolve(file);
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`knowledge file could not be loaded (${resolved}): ${error.message}`);
  }
  validateKnowledge(parsed);
  return parsed;
}

function validateKnowledge(knowledge) {
  const required = ['identity', 'contact', 'packages', 'pricingRules', 'portfolio', 'services'];
  for (const key of required) {
    if (!knowledge || knowledge[key] === undefined) throw new Error(`knowledge is missing "${key}"`);
  }
  if (!knowledge.identity.founder) throw new Error('knowledge is missing the founder');
  if (!Array.isArray(knowledge.packages) || !knowledge.packages.length) {
    throw new Error('knowledge is missing packages');
  }
  for (const pkg of knowledge.packages) {
    if (!pkg.id || !pkg.price || !pkg.platforms || !pkg.timeline) {
      throw new Error(`package ${pkg.id || '(unknown)'} is missing required fields`);
    }
  }
  return true;
}

/** Renders the public knowledge as a compact block for the prompt. */
function renderKnowledge(knowledge) {
  const lines = [];
  const identity = knowledge.identity;
  lines.push(`Business: ${identity.legalName} (branding also uses SAF AI).`);
  lines.push(`Brand line: "${identity.brandLine}"`);
  lines.push(`Based in ${identity.basedIn}, serving the ${identity.market} market.`);
  lines.push(`Founder: ${identity.founder}. If asked who founded the business, answer exactly: "${identity.founderStatement}"`);
  lines.push(`Website: ${identity.website}`);
  lines.push(`What we do: ${identity.plainLanguage}`);
  lines.push(`Model: ${identity.model}`);
  lines.push(`Who we serve: ${identity.whoWeServe}`);
  lines.push(`Possible use cases: ${identity.useCases}`);

  lines.push('');
  lines.push('Packages (published totals in South African rand, including VAT, not monthly subscriptions):');
  for (const pkg of knowledge.packages) {
    lines.push(`- ${pkg.names.join(' / ')}: ${pkg.price}. Platforms: ${pkg.platforms.join(', ')}. Published delivery indication: ${pkg.timeline}. ${pkg.priceNote} ${pkg.timelineNote || ''}`.trim());
  }
  lines.push(`Payment: ${knowledge.paymentTerms}`);

  lines.push('');
  lines.push('Services:');
  for (const service of knowledge.services) lines.push(`- ${service}`);

  lines.push('');
  lines.push('Portfolio references (descriptions only, no claims of live-store availability, downloads, financial results or client relationships):');
  for (const item of knowledge.portfolio) {
    lines.push(`- ${item.name}: ${item.description}`);
  }

  lines.push('');
  lines.push('Contact details published on the website:');
  lines.push(`- Email: ${knowledge.contact.email}`);
  lines.push(`- Telephone: ${knowledge.contact.telephone}`);
  lines.push(`- Additional number: ${knowledge.contact.additionalNumber}`);
  lines.push(`- Office: ${knowledge.contact.office}`);
  if (knowledge.contact.preferredForEnquiries?.length) {
    lines.push(`- When someone wants to reach a person, give them: ${knowledge.contact.preferredForEnquiries.join(' and ')}`);
  }
  if (knowledge.contact.handoffRule) lines.push(knowledge.contact.handoffRule);
  lines.push(`Note: ${knowledge.contact.caveat} ${knowledge.contact.officeHours}`);

  lines.push('');
  lines.push('Pricing and commitment rules you must follow:');
  for (const rule of knowledge.pricingRules) lines.push(`- ${rule}`);

  if (knowledge.designTool) {
    lines.push('');
    lines.push(`App designer: ${knowledge.designTool.description} ${knowledge.designTool.caveat}`);
  }
  if (knowledge.testimonials) {
    lines.push('');
    lines.push(`Testimonials and claims: ${knowledge.testimonials.note} ${knowledge.testimonials.rule}`);
  }
  if (knowledge.notEstablished?.length) {
    lines.push('');
    lines.push('Not established, so never state them as fact:');
    for (const item of knowledge.notEstablished) lines.push(`- ${item}`);
  }

  return lines.join('\n');
}

module.exports = { loadKnowledge, renderKnowledge, validateKnowledge };
