// A printed document's page title, which is also the file name when it is saved as PDF:
// "Invoice 105 - Mike Juma Wandeme & Co-operative Bank", like the paper ones' file names.
// Names are shortened (a customer or bank name can be 150 characters) so it stays about
// 110 characters at most, and characters Windows doesn't allow in file names are dropped.

const shorten = (text, max) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

/**
 * @param {string} doc     "Invoice 105", "Proforma 490-R1", "Payslip EMP-0007 week of 3 Nov"
 * @param {string} name    who it is for
 * @param {string|null} [also]  a second party (the bank financing the vehicle)
 */
export function fileTitle(doc, name, also = null) {
  const who = also ? `${shorten(name, 50)} & ${shorten(also, 40)}` : shorten(name, 90);
  return `${doc} - ${who}`.replace(/[\\/:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim();
}
