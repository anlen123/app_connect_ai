export async function menuClick(page, id, touch = false) {
  const target = page.locator(`#${id}`), method = touch ? 'tap' : 'click';
  if (!await target.isVisible()) await page.locator('#sessionMenu > summary')[method]();
  await target[method]();
}
