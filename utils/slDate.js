/**
 * Asia/Colombo timezone helpers
 */

function slDateString(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date);
}

function slToday() {
  return new Date(slDateString());
}

function slMonthYear(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo',
    year: 'numeric',
    month: 'numeric'
  }).formatToParts(date);
  const year = parseInt(parts.find(p => p.type === 'year').value, 10);
  const month = parseInt(parts.find(p => p.type === 'month').value, 10);
  return { month, year };
}

function slPeriod(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  const hour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo',
    hour: 'numeric',
    hourCycle: 'h23'
  }).format(date), 10);
  return hour < 12 ? 'MORNING' : 'EVENING';
}

// Returns the Asia/Colombo hour 0-23 using formatToParts
function slHour(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo',
    hour: 'numeric',
    hourCycle: 'h23'
  }).formatToParts(date);
  return parseInt(parts.find(p => p.type === 'hour').value, 10);
}

// Single implementation; slPeriod is the Request-1 alias
const currentPeriod = slPeriod;

// 'HOME_TO_SCHOOL' during MORNING, 'SCHOOL_TO_HOME' during EVENING
function activeDirection(d = new Date()) {
  return currentPeriod(d) === 'MORNING' ? 'HOME_TO_SCHOOL' : 'SCHOOL_TO_HOME';
}

// True when the given route direction matches the current active period
function isRouteLiveNow(direction, d = new Date()) {
  return direction === activeDirection(d);
}

function formatSLTime(d = new Date()) {
  const date = d instanceof Date ? d : new Date(d);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Colombo',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date).replace(/\u202F/g, ' ');
}

module.exports = {
  slDateString,
  slToday,
  slMonthYear,
  slPeriod,
  slHour,
  currentPeriod,
  activeDirection,
  isRouteLiveNow,
  formatSLTime
};
