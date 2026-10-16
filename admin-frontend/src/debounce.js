/**
 * Coalesce rapid calls; cancel pending work when its view is replaced.
 * @param {() => void} callback
 * @param {number} delay
 */
export function debounce(callback, delay) {
  let timer;
  const cancel = () => clearTimeout(timer);
  const schedule = () => {
    cancel();
    timer = setTimeout(callback, delay);
  };
  return { schedule, cancel };
}
