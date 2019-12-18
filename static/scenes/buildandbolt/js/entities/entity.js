goog.provide('app.Entity');

goog.require('app.Board');

app.Entity = class Entity {
  constructor() {
    this.elem = document.createElement('div');
    document.getElementById(this.constructor.targetHolderId).append(this.elem);
    this.elem.setAttribute('class', this.constructor.elemClass);
  }

  // for app.shared.pools
  onInit(config) {
    // all entities trigger action on cell by default
    this.config = config;

    this.elem.classList.remove('hidden');
    this.render();
    app.Board.addEntityToBoard(this,
        this.config.x, this.config.y,
        this.config.width, this.config.height);
  }

  // for app.shared.pools
  onDispose() {
    this.elem.classList.add('hidden');
  }

  onFrame() {

  }

  render() {

  }

  /**
   * Returns the action(s) that result from the player colliding with this entity,
   * or null if no effect.
   */
  onContact(player) {
    return null;
  }
}