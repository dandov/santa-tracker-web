goog.provide('app.ScoreManager')

goog.require('app.LevelManager')
goog.require('app.ScoreScreen')
goog.require('app.ToysBoard')

// singleton to manage the game
class ScoreManager {
  constructor() {
    this.scoresDict = {} // store players' score by player's ids
  }

  init(game) {
    this.game = game
    this.initScoresDict()
  }

  initScoresDict() {
    // create a dictionnary of players with their current scores
    for (let i = 0; i < this.game.players.length; i++) {
      const player = this.game.players[i]
      this.scoresDict[player.id] = {
        toysInLevel: 0,
        toys: [],
      }
    }
  }

  updateScore(id) {
    const { toyType, toysCapacity } = app.LevelManager
    const player = this.scoresDict[id]
    player.toysInLevel++
    player.toys.push(toyType.key)
    // update toys board
    app.ToysBoard.updateScore(id, toysCapacity - player.toysInLevel)
    // update score screen
    app.ScoreScreen.updateScore(id, player.toys.length, toyType.key)

    window.santaApp.fire('sound-trigger', 'buildandbolt_yay_2', id)

    if (player.toysInLevel === toysCapacity) { // end of level
      this.endLevel()
    }
  }

  endLevel() {
    let scoreResult
    if (this.game.multiplayer) {
      scoreResult = this.setWinner()
    } else {
      scoreResult = this.setWinnerSinglePlayer()
    }

    // reset toysInLevels
    this.resetToysInLevels()

    if (app.LevelManager.current < Levels.length - 1) {
      // show winner screen
      app.ScoreScreen.show()
    } else {
      // last level, show end screen
      app.ScoreScreen.showEnd(scoreResult, this.game.multiplayer)
    }

    this.game.pause() // pause game, it's stopping the scoreboard timer
  }

  setWinner() {
    const { players } = this.game
    const playersState = []

    for (let i = 0; i < players.length; i++) {
      playersState.push({
        id: players[i].id,
        state: null
      })
    }

    let tie = false

    if (this.scoresDict[players[0].id].toys.length > this.scoresDict[players[1].id].toys.length) {
      playersState[0].state = 'win'
      playersState[1].state = 'lose'
    } else if (this.scoresDict[players[0].id].toys.length < this.scoresDict[players[1].id].toys.length) {
      playersState[0].state = 'lose'
      playersState[1].state = 'win'
    } else {
      // tie
      playersState[0].state = 'win'
      playersState[1].state = 'win'
      tie = true
    }

    app.ScoreScreen.updateCharacters(playersState)

    return { playersState, tie }
  }

  setWinnerSinglePlayer() {
    const { players } = this.game
    const { toysCapacity } = app.LevelManager
    const playersState = [{
      id: players[0].id,
      state: null
    }]

    const tie = false

    if (this.scoresDict[players[0].id].toysInLevel === toysCapacity) {
      playersState[0].state = 'win'
    } else {
      playersState[0].state = 'lose'
    }

    app.ScoreScreen.updateCharacters(playersState)

    return { playersState, tie }
  }

  resetToysInLevels() {
    for (let i = 0; i < this.game.players.length; i++) {
      const player = this.game.players[i]
      this.scoresDict[player.id].toysInLevel = 0
    }
  }

  reset() {
    for (let i = 0; i < this.game.players.length; i++) {
      const player = this.game.players[i]
      this.scoresDict[player.id].toysInLevel = 0
      this.scoresDict[player.id].toys = []

      // update toys board
      app.ToysBoard.updateScore(player.id, 0)
      // update score screen
      app.ScoreScreen.reset(player.id, 0)
    }

    app.ToysBoard.updateLevel()
    app.ScoreScreen.hide()
  }
}

app.ScoreManager = new ScoreManager()
