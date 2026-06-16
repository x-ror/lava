// The scheduler must keep working after userland mutates common intrinsics.
// process.nextTick/queueMicrotask are runtime primitives; they should not depend
// on the live Array/Promise/Function prototype methods once installed.
(function () {
  let hits = 0;

  Array.prototype.push = function () {
    throw new Error('push poisoned');
  };
  Array.prototype.shift = function () {
    throw new Error('shift poisoned');
  };
  Array.prototype.slice = function () {
    throw new Error('slice poisoned');
  };
  Promise.resolve = function () {
    throw new Error('resolve poisoned');
  };
  // oxlint-disable-next-line unicorn/no-thenable
  Promise.prototype.then = function () {
    throw new Error('then poisoned');
  };
  Function.prototype.call = function () {
    throw new Error('call poisoned');
  };
  Function.prototype.apply = function () {
    throw new Error('apply poisoned');
  };

  process.nextTick(
    (a, b) => {
      if (a + b === 'xy') hits += 1;
    },
    'x',
    'y',
  );
  queueMicrotask(() => {
    hits += 10;
  });

  setTimeout(() => {
    if (hits !== 11) process.exitCode = 1;
  }, 0);
})();
