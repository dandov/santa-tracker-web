import SceneManager from '../components/SceneManager/index.js'

export default class CameraControls {
  constructor(el) {
    this.el = el

    this.ui = {
      zoomButtons: [...this.el.querySelectorAll('[data-zoom]')],
      rotateButtons: [...this.el.querySelectorAll('[data-rotate-camera]')]
    }

    this.zoom = this.zoom.bind(this)
    this.rotateCamera = this.rotateCamera.bind(this)

    this.events()
  }

  events() {
    this.ui.zoomButtons.forEach(button => {
      button.addEventListener('click', this.zoom)
    })

    this.ui.rotateButtons.forEach(button => {
      button.addEventListener('click', this.rotateCamera)
    })
  }

  zoom(e) {
    const el = e.currentTarget
    this.ui.zoomButtons.forEach(button => {
      button.classList.remove('is-disabled')
    })
    SceneManager.cameraCtrl.zoom(el.dataset.zoom, el)
    this.pushButton(el)
  }

  rotateCamera(e) {
    const el = e.currentTarget
    SceneManager.cameraCtrl.rotate(el.dataset.rotateCamera)
    this.pushButton(el)
  }

  pushButton(el) {
    el.classList.add('is-clicked')
    setTimeout(() => {
      el.classList.remove('is-clicked')
    }, 200)
  }
}

